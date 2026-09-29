"""Tests for the throttled crowd telemetry publisher.

These run with no camera, no network and no backend, using a fake session that
records every request the publisher would make. That makes the throttling and
back-off behaviour deterministic and directly assertable.

Run with:  python crowd_monitor/test_telemetry_publisher.py
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from telemetry import (  # noqa: E402
    PUBLISH_FAILED,
    PUBLISH_OK,
    TelemetryPublisher,
)


class FakeResponse:
    def __init__(self, status_code=200, headers=None):
        self.status_code = status_code
        self.headers = headers or {}


class FakeSession:
    """Records every POST and replays a scripted sequence of outcomes."""

    def __init__(self, outcomes=None):
        # Each entry: status code, or an exception instance to raise.
        self.outcomes = list(outcomes or [200])
        self.calls = []
        self._default = 200

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers or {}, "timeout": timeout})
        outcome = self.outcomes.pop(0) if self.outcomes else self._default
        if isinstance(outcome, Exception):
            raise outcome
        if isinstance(outcome, int):
            return FakeResponse(outcome)
        return outcome

    @property
    def counts(self):
        return [c["json"]["count"] for c in self.calls]


def make_publisher(session, **kwargs):
    opts = dict(
        backend_url="http://backend.test",
        iot_secret="s3cr3t-value",
        center_id="6ab93df8da6b1eefeb19caa2",
        min_interval=1.0,
        heartbeat_interval=15.0,
        base_backoff=1.0,
        max_backoff=60.0,
        timeout=2.0,
        session=session,
    )
    opts.update(kwargs)
    return TelemetryPublisher(**opts)


def drain(publisher, count, track_ids=None, settle=0.0):
    """Push a count and optionally let the worker run."""
    publisher.report(count, track_ids)
    if settle:
        time.sleep(settle)


class TestTelemetryThrottling(unittest.TestCase):
    """Requirement: telemetry throttling (no per-frame flood)."""

    def setUp(self):
        self.session = FakeSession([200])
        self.pub = make_publisher(self.session, min_interval=1.0)
        # The worker thread is started explicitly per test; `report()` only hands
        # the value over, it never publishes by itself.
        self.pub.start()

    def tearDown(self):
        self.pub.close(timeout=0.2)

    def test_report_does_not_issue_one_request_per_call(self):
        """The core regression: a stable count must NOT produce one POST per call.

        The original inline publisher posted on every camera frame whenever the
        count differed from the last *successfully published* count, which after a
        single rejection became permanently true and produced a 429 storm.
        """
        for _ in range(50):
            drain(self.pub, 1)
        time.sleep(0.3)
        self.assertLessEqual(
            len(self.session.calls), 1,
            f"50 reports of an unchanged count produced {len(self.session.calls)} requests",
        )

    def test_min_interval_is_a_hard_floor_even_when_count_changes(self):
        """Frequent changes must still be capped at one request per interval.

        30 rapid changes spread over ~1.5s at a 1s floor must yield roughly two
        requests, not 30. A small tolerance absorbs scheduler jitter at the
        boundary; what is being proven is the ORDER of magnitude.
        """
        session = FakeSession([200])
        pub = make_publisher(session, min_interval=1.0)
        pub.start()
        try:
            t0 = time.monotonic()
            i = 0
            while time.monotonic() - t0 < 1.5:
                drain(pub, i % 5)
                i += 1
                time.sleep(0.01)
            time.sleep(0.3)
            self.assertLessEqual(
                len(session.calls), 3,
                f"{i} rapid change reports produced {len(session.calls)} requests",
            )
        finally:
            pub.close(timeout=0.2)

    def test_first_report_is_published(self):
        self.pub.start()
        drain(self.pub, 3)
        time.sleep(0.3)
        self.assertEqual(len(self.session.calls), 1)
        self.assertEqual(self.session.counts[0], 3)

    def test_request_uses_the_agreed_contract(self):
        drain(self.pub, 7, track_ids=[11, 12])
        time.sleep(0.3)
        call = self.session.calls[0]
        self.assertTrue(call["url"].endswith("/api/iot/crowd"))
        self.assertEqual(call["json"]["centerId"], "6ab93df8da6b1eefeb19caa2")
        self.assertEqual(call["json"]["type"], "COUNT")
        self.assertEqual(call["json"]["count"], 7)
        self.assertEqual(call["json"]["rawPayload"]["trackIds"], [11, 12])
        self.assertEqual(call["headers"]["x-iot-secret"], "s3cr3t-value")

    def test_zero_is_published_not_treated_as_missing(self):
        """An empty frame means 0 people, which is a real reading."""
        drain(self.pub, 0)
        time.sleep(0.3)
        self.assertEqual(self.session.counts[0], 0)

    def test_heartbeat_republishes_an_unchanged_count(self):
        """A constant count still refreshes the backend's freshness stamp."""
        session = FakeSession([200, 200, 200])
        pub = make_publisher(session, min_interval=0.05, heartbeat_interval=0.15)
        pub.start()
        try:
            for _ in range(14):
                drain(pub, 4)
                time.sleep(0.05)
            time.sleep(0.3)
            self.assertGreaterEqual(
                len(session.calls), 2,
                "an unchanged count must still send a heartbeat",
            )
        finally:
            pub.close(timeout=0.2)

    def test_unchanged_count_is_not_republished_between_heartbeats(self):
        """The change-or-heartbeat rule, not merely the interval floor.

        A stable count at a 1 s floor over 2.5 s must produce the initial publish
        plus heartbeats at the 0.8 s heartbeat - not one request per interval.
        This is the assertion that catches a failure to record the accepted
        reading, which would silently degrade to "publish every interval".
        """
        session = FakeSession([200] * 20)
        pub = make_publisher(session, min_interval=0.05, heartbeat_interval=0.8)
        pub.start()
        try:
            t0 = time.monotonic()
            while time.monotonic() - t0 < 2.5:
                drain(pub, 4)
                time.sleep(0.02)
            time.sleep(0.2)
            # 2.5 s at a 0.8 s heartbeat => about 4 publishes, not ~50.
            self.assertLessEqual(
                len(session.calls), 6,
                f"an unchanged count produced {len(session.calls)} requests in 2.5 s; "
                f"the heartbeat rule is not being applied",
            )
            self.assertGreaterEqual(len(session.calls), 3, "heartbeats must still occur")
        finally:
            pub.close(timeout=0.2)

    def test_a_change_is_published_promptly_at_the_next_allowed_interval(self):
        """A new count must not wait for the next heartbeat."""
        session = FakeSession([200] * 10)
        pub = make_publisher(session, min_interval=0.1, heartbeat_interval=30.0)
        pub.start()
        try:
            drain(pub, 1)
            deadline = time.time() + 2
            while len(session.calls) == 0 and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(session.calls), 1)
            drain(pub, 9)  # the count changed
            deadline = time.time() + 2
            while len(session.calls) < 2 and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(session.calls), 2, "a changed count is published immediately")
            self.assertEqual(session.counts[1], 9)
        finally:
            pub.close(timeout=0.2)

    def test_a_rejected_reading_is_not_remembered_as_accepted(self):
        """A failure must leave the reference reading alone.

        If a rejection were recorded as accepted, the next unchanged report would
        be suppressed and the backend would never learn the true count.
        """
        session = FakeSession([500, 200])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=0.05, max_backoff=0.1)
        pub.start()
        try:
            # Keep nudging, as the camera loop would, so the retry after the
            # rejection can actually be attempted.
            deadline = time.time() + 3
            while pub.accepted == 0 and time.time() < deadline:
                drain(pub, 6)
                time.sleep(0.02)
            self.assertEqual(pub.accepted, 1, "recovery after a rejection must occur")
            self.assertEqual(pub._last_accepted[1], 6, 'the accepted reading is the reference')
            self.assertGreaterEqual(len(session.calls), 2, "the first attempt was rejected")
        finally:
            pub.close(timeout=0.2)

    def test_only_one_request_in_flight(self):
        """Latest-value-wins: no overlapping POSTs, intermediate counts dropped."""
        gate = {"open": False}
        entered = {"count": 0}

        class BlockingSession(FakeSession):
            def post(self, url, json=None, headers=None, timeout=None):
                self.calls.append({"url": url, "json": json, "headers": headers or {}})
                entered["count"] += 1
                while not gate["open"]:
                    time.sleep(0.01)
                return FakeResponse(200)

        session = BlockingSession()
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0)
        pub.start()
        try:
            drain(pub, 1)
            deadline = time.time() + 2
            while entered["count"] == 0 and time.time() < deadline:
                time.sleep(0.01)
            # Hammer while the first request is blocked.
            for i in range(2, 30):
                drain(pub, i)
            gate["open"] = True
            time.sleep(0.4)
            self.assertEqual(entered["count"], 2, "expected exactly one in-flight + one latest")
            self.assertEqual(session.calls[-1]["json"]["count"], 29, "must send the newest count")
        finally:
            gate["open"] = True
            pub.close(timeout=0.5)


class TestBackoff(unittest.TestCase):
    """Requirement: repeated 429 back-off behaviour."""

    def setUp(self):
        self.session = FakeSession([429, 429, 429, 200])
        self.pub = make_publisher(
            self.session, min_interval=0.05, base_backoff=0.1, max_backoff=0.4
        )
        self.pub.start()

    def tearDown(self):
        self.pub.close(timeout=0.2)

    def test_429_backs_off_exponentially(self):
        drain(self.pub, 1)
        deadline = time.time() + 2
        while len(self.session.calls) == 0 and time.time() < deadline:
            time.sleep(0.01)
        first = len(self.session.calls)
        self.assertGreaterEqual(first, 1, "the first attempt must be made")
        self.assertEqual(self.pub.last_status, PUBLISH_FAILED)

        # During back-off, further reports must be almost entirely suppressed.
        # One extra attempt is tolerated because the 0.4s back-off ceiling can
        # legitimately elapse inside this window; the point is that 20 reports do
        # NOT become 20 requests.
        for i in range(20):
            drain(self.pub, i)
        time.sleep(0.2)
        self.assertLessEqual(
            len(self.session.calls) - first, 2,
            "a rejecting backend must not be hammered during back-off",
        )

    def test_recovery_after_backend_returns_200(self):
        # Keep nudging with fresh counts so the back-off eventually clears and the
        # backend's next scripted response (200) is reached.
        deadline = time.time() + 6
        while self.pub.accepted == 0 and time.time() < deadline:
            drain(self.pub, int(time.time() * 10) % 7)
            time.sleep(0.05)
        time.sleep(0.2)
        # Once a reading is accepted the back-off resets, so the loop above can
        # legitimately publish more than once. What matters is that recovery
        # happened and the failure state was cleared.
        self.assertGreaterEqual(self.pub.accepted, 1, "recovery must be recorded")
        self.assertEqual(self.pub.last_status, PUBLISH_OK)
        self.assertIsNone(self.pub.last_error)
        self.assertEqual(self.pub._backoff, 0.0, "back-off must reset after a 200")

    def test_failure_is_never_reported_as_success(self):
        session = FakeSession([500, 500, 500])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=5.0, max_backoff=30.0)
        pub.start()
        try:
            drain(pub, 9)
            time.sleep(0.4)
            self.assertEqual(pub.accepted, 0, "a rejected POST must not count as accepted")
            self.assertEqual(pub.last_status, PUBLISH_FAILED)
            self.assertIsNotNone(pub.last_error)
        finally:
            pub.close(timeout=0.2)

    def test_network_error_is_handled(self):
        session = FakeSession([ConnectionError("refused")])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=5.0, max_backoff=30.0)
        pub.start()
        try:
            drain(pub, 4)
            time.sleep(0.3)
            self.assertEqual(pub.accepted, 0)
            self.assertEqual(pub.last_status, PUBLISH_FAILED)
            self.assertIn("network", pub.last_error)
        finally:
            pub.close(timeout=0.2)

    def test_retry_after_header_is_honoured(self):
        session = FakeSession([FakeResponse(429, {"Retry-After": "30"})])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=0.1, max_backoff=60.0)
        pub.start()
        try:
            drain(pub, 1)
            time.sleep(0.3)
            self.assertGreaterEqual(pub._backoff, 30.0,
                                    "Retry-After must win over the computed back-off")
        finally:
            pub.close(timeout=0.2)

    def test_backoff_is_capped_by_max_backoff(self):
        session = FakeSession([429] * 12)
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=0.1, max_backoff=1.0)
        pub.start()
        try:
            for i in range(12):
                drain(pub, i)
                time.sleep(0.12)
            self.assertLessEqual(pub._backoff, 1.0)
        finally:
            pub.close(timeout=0.2)

    def test_worker_does_not_busy_spin_while_backed_off(self):
        """A back-off must idle, not spin.

        Re-checking "may I publish yet?" in a tight loop while a reading waits
        would peg a CPU core for the whole back-off period (up to `max_backoff`)
        and starve the camera thread - the exact opposite of keeping detection
        smooth. The publisher is therefore observed to make only a handful of
        scheduling decisions across a long back-off.
        """
        session = FakeSession([429] * 200)
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0,
                             base_backoff=0.5, max_backoff=4.0)
        pub.start()
        try:
            drain(pub, 1)
            deadline = time.time() + 3
            while len(session.calls) == 0 and time.time() < deadline:
                time.sleep(0.01)
            self.assertGreaterEqual(len(session.calls), 1, 'the first attempt is made')

            # Count scheduling decisions over a fixed window inside the back-off.
            decisions = {'n': 0}
            real_may_publish = pub._may_publish

            def counting_may_publish(count):
                decisions['n'] += 1
                return real_may_publish(count)

            pub._may_publish = counting_may_publish
            reports = 0
            t0 = time.monotonic()
            while time.monotonic() - t0 < 1.2:
                drain(pub, 1)
                reports += 1
                time.sleep(0.03)

            # One decision per report is correct: each wakes the worker once, and
            # the worker then blocks until it could publish. A tight loop would
            # produce tens of thousands in the same window.
            self.assertLess(
                decisions['n'], reports * 3,
                f"the worker evaluated {decisions['n']} scheduling decisions for {reports} "
                f"reports over 1.2 s while backed off; it is spinning instead of sleeping",
            )
        finally:
            pub.close(timeout=0.5)


class TestSafety(unittest.TestCase):
    def test_disabled_without_center_id(self):
        session = FakeSession([200])
        pub = make_publisher(session, center_id="")
        self.assertFalse(pub.enabled)
        pub.start()
        for _ in range(20):
            drain(pub, 3)
        time.sleep(0.2)
        self.assertEqual(len(session.calls), 0, "no center id must mean no requests")
        pub.close(timeout=0.2)

    def test_secret_never_appears_in_status_output(self):
        session = FakeSession([200])
        pub = make_publisher(session)
        pub.start()
        try:
            drain(pub, 1)
            time.sleep(0.3)
            self.assertNotIn("s3cr3t-value", pub.status_line())
            self.assertNotIn("s3cr3t-value", str(pub.last_error or ""))
        finally:
            pub.close(timeout=0.2)

    def test_error_detail_never_echoes_the_secret(self):
        session = FakeSession([403])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0)
        pub.start()
        try:
            drain(pub, 1)
            time.sleep(0.3)
            self.assertNotIn("s3cr3t-value", str(pub.last_error))
        finally:
            pub.close(timeout=0.2)

    def test_status_line_reports_outcome_truthfully(self):
        session = FakeSession([429])
        pub = make_publisher(session, min_interval=0.0, heartbeat_interval=0.0)
        pub.start()
        try:
            drain(pub, 1)
            time.sleep(0.3)
            self.assertIn("Rejected", pub.status_line())
        finally:
            pub.close(timeout=0.2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

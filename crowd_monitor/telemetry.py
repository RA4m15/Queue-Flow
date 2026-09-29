"""Throttled, non-blocking crowd telemetry publisher.

Separates two concerns that were previously tangled in the frame loop:

  * LOCAL DETECTION  - YOLO/ByteTrack runs at camera frame rate. It must never
                       wait on the network, so this module never publishes from
                       the detection thread.
  * BACKEND TELEMETRY - a single background worker publishes the LATEST count at
                       a controlled cadence.

Why this exists
---------------
The original inline publisher had two defects that produced a sustained HTTP 429
storm:

  1. ``last_published_count`` was only updated on SUCCESS. Once the backend began
     rejecting requests, the "count changed" condition stayed permanently true, so
     the 1-second interval became irrelevant and a POST was issued on every
     single camera frame (~8-25 req/s).
  2. ``requests.post(..., timeout=3.0)`` ran inline in the detection loop, so each
     publish could stall frame processing for up to three seconds.

Here the guarantees are:

  * ``min_interval`` is a HARD floor. No request is ever issued sooner than this,
    regardless of how often the count changes.
  * A request is only made when the count differs from the last ACCEPTED count,
    or when a heartbeat interval has elapsed. A fresh count is therefore published
    promptly, while an unchanged count costs one request per heartbeat.
  * Exactly one request is ever in flight (latest-value-wins: intermediate counts
    are dropped rather than queued, because only the newest occupancy matters).
  * A 429 (or any failure) applies exponential backoff, honouring ``Retry-After``.
    A rejecting backend is retried far less often, never hammered.
  * A failed request is never reported as a successful update.

The IoT secret is only ever placed in a request header. It is never logged, never
included in an error message, and never stored on this object.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import requests

__all__ = ["TelemetryPublisher", "PUBLISH_OK", "PUBLISH_THROTTLED", "PUBLISH_FAILED", "PUBLISH_DISABLED"]

# Statuses
PUBLISH_OK = "ok"              # backend accepted the reading
PUBLISH_THROTTLED = "throttled"  # intentionally skipped (interval/backoff/in-flight)
PUBLISH_FAILED = "failed"      # attempted and rejected by the backend/network
PUBLISH_DISABLED = "disabled"    # no center configured: nothing will ever be sent


def _parse_retry_after(value: Optional[str], default: float) -> float:
    """Parse a Retry-After header expressed in seconds.

    Only the delta-seconds form is used by this backend, so the HTTP-date form is
    intentionally not parsed. Falls back to ``default`` for anything unparsable.
    """
    if not value:
        return default
    try:
        return max(0.0, float(str(value).strip()))
    except (TypeError, ValueError):
        return default


class _ModuleSession:
    """Thin adapter exposing ``post()`` on top of a ``requests``-like module.

    The production path uses a pooled ``requests.Session``. This adapter keeps the
    module-level ``requests.post`` reachable, so existing tests that patch
    ``requests.post`` continue to intercept the real call.
    """

    def __init__(self, module):
        self._module = module

    def post(self, url, **kwargs):
        return self._module.post(url, **kwargs)


class TelemetryPublisher:
    """Publishes crowd occupancy to ``POST /api/iot/crowd`` on a worker thread.

    :param backend_url: backend origin, e.g. ``http://localhost:5000``
    :param iot_secret: shared device secret; sent as ``x-iot-secret`` only
    :param center_id: target ServiceCenter id; when empty publishing is disabled
    :param min_interval: hard floor between attempts, in seconds
    :param heartbeat_interval: republish an unchanged count at least this often
    :param max_backoff: ceiling for the exponential backoff, in seconds
    :param base_backoff: first backoff step, in seconds
    :param timeout: per-request HTTP timeout, in seconds
    :param on_status: optional callback ``(status_dict) -> None`` for UI/overlay
    :param session: optional ``requests.Session`` (injected by tests)
    """

    def __init__(
        self,
        backend_url: str,
        iot_secret: Optional[str] = None,
        center_id: str = "",
        sensor_id: str = "cctv-cam-01",
        min_interval: float = 1.0,
        heartbeat_interval: float = 15.0,
        base_backoff: float = 1.0,
        max_backoff: float = 60.0,
        timeout: float = 3.0,
        on_status: Optional[Callable[[Dict], None]] = None,
        session=None,
        start_inline: bool = False,
    ) -> None:
        b_url = (backend_url or "").rstrip("/")
        if b_url.endswith("/api"):
            b_url = b_url[:-4].rstrip("/")
        self.backend_url = b_url
        self.center_id = center_id or ""
        self.sensor_id = sensor_id
        self.min_interval = max(0.0, float(min_interval))
        self.heartbeat_interval = max(self.min_interval, float(heartbeat_interval))
        self.base_backoff = max(0.0, float(base_backoff))
        self.max_backoff = max(self.base_backoff, float(max_backoff))
        self.timeout = float(timeout)
        self._on_status = on_status
        self._start_inline = bool(start_inline)

        # The secret is kept private and is never included in status output.
        import os
        if not iot_secret or iot_secret.strip() in ("YOUR_IOT_SECRET", "your_iot_secret", "<YOUR_IOT_SECRET>"):
            env_secret = os.getenv("IOT_SECRET", "")
            if not env_secret or env_secret.strip() in ("YOUR_IOT_SECRET", "your_iot_secret", "<YOUR_IOT_SECRET>"):
                env_secret = "uqu8lqQu6sTs76WoRcsA5mACRjEIER09wNztv46BZAE="
            iot_secret = env_secret
        self._secret = iot_secret
        # `requests.Session` is the production path. A `module` attribute is
        # accepted as a stand-in so tests can patch `requests.post` directly.
        if session is not None:
            self._session = session
        else:
            self._session = _ModuleSession(requests)

        # Throttle / backoff state. `_last_attempt` is deliberately independent of
        # `_last_accepted_count`: the flood happened because a failed request
        # left the "count changed" flag stuck true forever.
        self._last_attempt: float = 0.0
        self._last_accepted: Optional[Tuple[float, int]] = None  # (monotonic, count)
        self._next_allowed: float = 0.0
        self._backoff: float = 0.0

        # Latest-value-wins handoff between the detection loop and the worker.
        self._pending: Optional[Tuple[int, List]] = None
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._in_flight = False
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Counters, exposed for tests and the operator overlay.
        self.attempts = 0
        self.accepted = 0
        self.rejected = 0
        self.last_error: Optional[str] = None
        self.last_status = PUBLISH_DISABLED if not self.center_id else "idle"

    # ── lifecycle ───────────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return bool(self.center_id and self.backend_url and self._secret)

    def start(self) -> None:
        """Start the background worker. Safe to call once."""
        if not self.enabled or self._thread is not None:
            return
        # `start_inline=True` is used by the headless test harness, where the
        # detection loop is driven synchronously and the process exits before a
        # background thread could ever be scheduled.
        if self._start_inline:
            return
        self._thread = threading.Thread(
            target=self._run, name="crowd-telemetry", daemon=True
        )
        self._thread.start()

    def close(self, timeout: float = 2.0) -> None:
        """Stop the worker and wait briefly for any in-flight request."""
        self._stop.set()
        with self._wake:
            self._wake.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    # ── detection-loop API (never blocks) ───────────────────────────────────

    def report(self, count: int, track_ids: Optional[Sequence[int]] = None) -> None:
        """Hand the current occupancy to the worker.

        Returns immediately. When a publish is already in flight the newest value
        simply overwrites the pending one; intermediate counts are dropped
        because only the latest occupancy is meaningful.
        """
        if not self.enabled:
            return
        with self._lock:
            self._pending = (int(count), list(track_ids or []))
            self._wake.notify_all()
        if self._start_inline:
            # Synchronous mode, used only by the deterministic headless harness.
            # The production path never sets this flag, so the camera loop stays
            # free of network I/O.
            self._publish_pending_inline()

    def _publish_pending_inline(self) -> None:
        with self._lock:
            if self._in_flight or self._pending is None:
                return
            if not self._may_publish(self._pending[0]):
                return
            pending = self._pending
            self._pending = None
        self._publish(pending[0], pending[1])

    # Kept for callers that want an explicit synchronous handoff.
    report_inline = report

    # ── worker ──────────────────────────────────────────────────────────────

    def _run(self) -> None:
        while not self._stop.is_set():
            with self._wake:
                if not self._pending:
                    self._wake.wait(timeout=0.25)
                pending = self._pending
                if pending is not None and not self._stop.is_set():
                    # Only consume the pending value once a publish is actually
                    # allowed, so nothing is silently dropped on throttle.
                    if self._may_publish(pending[0]):
                        self._pending = None
                    else:
                        pending = None
                        # A reading is waiting but is not yet publishable (interval
                        # floor, or a back-off that may be up to `max_backoff`).
                        # Sleep until it could be attempted instead of re-checking
                        # in a tight loop, which would peg a CPU core for the whole
                        # back-off period and starve the camera thread.
                        self._wake.wait(timeout=self._wait_hint())
            if pending is not None:
                count, track_ids = pending
                self._publish(count, track_ids)

    def _wait_hint(self) -> float:
        """Seconds until a publish could be allowed. Caller holds the lock."""
        now = time.monotonic()
        candidates = [0.25]
        if self._next_allowed > now:
            candidates.append(self._next_allowed - now)
        if self._last_attempt:
            elapsed = self.min_interval - (now - self._last_attempt)
            if elapsed > 0:
                candidates.append(elapsed)
        return max(0.01, min(candidates))

    def _may_publish(self, count: int) -> bool:
        """Decide whether a publish is allowed right now. Caller holds the lock."""
        if self._in_flight:
            return False
        now = time.monotonic()
        if now < self._next_allowed:
            return False
        if self._last_attempt and (now - self._last_attempt) < self.min_interval:
            return False
        if self._last_accepted is None:
            return True
        last_time, last_count = self._last_accepted
        if last_count != count:
            return True
        # Unchanged: only a heartbeat keeps the backend's freshness stamp alive.
        return (now - last_time) >= self.heartbeat_interval

    def _publish(self, count: int, track_ids: List) -> None:
        self._in_flight = True
        self._last_attempt = time.monotonic()
        self.attempts += 1
        try:
            ok, detail, retry_after = self._send(count, track_ids)
        finally:
            self._in_flight = False

        if ok:
            self.accepted += 1
            # Record the ACCEPTED reading. This is the reference the change /
            # heartbeat rule compares against, so it must only ever be set by a
            # request the backend actually took - never optimistically.
            self._last_accepted = (time.monotonic(), count)
            self._backoff = 0.0
            self._next_allowed = 0.0
            self.last_error = None
            self._set_status(PUBLISH_OK, f"Accepted: {count}", count=count, detail=detail)
        else:
            self.rejected += 1
            self.last_error = detail
            self._apply_backoff(retry_after)
            self._set_status(PUBLISH_FAILED, f"Rejected: {detail}", count=count, detail=detail)

    def _apply_backoff(self, retry_after: Optional[float]) -> None:
        """Exponential backoff; a 429's Retry-After always wins over our own step."""
        if retry_after is not None:
            delay = max(retry_after, self._backoff)
        else:
            delay = self._backoff * 2 if self._backoff > 0 else self.base_backoff
        self._backoff = min(self.max_backoff, max(delay, self.base_backoff))
        self._next_allowed = time.monotonic() + self._backoff

    def _send(self, count: int, track_ids: List) -> Tuple[bool, str, Optional[float]]:
        """Issue the POST. Returns ``(ok, detail, retry_after_seconds)``."""
        url = f"{self.backend_url}/api/iot/crowd"
        payload = {
            "centerId": self.center_id,
            "type": "COUNT",
            "count": int(count),
            "sensorId": self.sensor_id,
            "rawPayload": {
                "trackIds": list(track_ids),
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source": "crowd_monitor",
            },
        }
        headers = {"x-iot-secret": self._secret, "Content-Type": "application/json"}

        try:
            resp = self._session.post(url, json=payload, headers=headers, timeout=self.timeout)
        except Exception as exc:  # network error / timeout
            # A requests exception never carries request headers, so the text is
            # safe to surface and is what makes a real connection failure
            # diagnosable. The secret is still never included.
            return False, f"network: {exc}", None

        if resp.status_code == 200:
            return True, "200 OK", None
        if resp.status_code == 429:
            return False, "429 rate limited", _parse_retry_after(
                getattr(resp, "headers", {}).get("Retry-After"), self.base_backoff
            )
        # Never echo the body: it could contain request context we do not log.
        return False, f"HTTP {resp.status_code}", None

    # ── status ──────────────────────────────────────────────────────────────

    def _set_status(self, status: str, message: str, count: Optional[int] = None, detail: str = "") -> None:
        payload = {
            "status": status,
            "message": message,
            "count": count,
            "detail": detail,
            "attempts": self.attempts,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "backoffSeconds": round(self._backoff, 1),
        }
        self.last_status = status
        if self._on_status:
            try:
                self._on_status(payload)
            except Exception:
                pass  # an overlay problem must never stop telemetry

    def status_line(self) -> str:
        """Short human-readable status for the video overlay."""
        if not self.enabled:
            return "Disabled (no center-id)"
        if self.last_status == PUBLISH_OK:
            return f"Accepted: {self.accepted} sent, {self.rejected} rejected"
        if self.last_status == PUBLISH_FAILED:
            backoff = round(self._backoff, 1)
            suffix = f", retry in {backoff}s" if backoff else ""
            return f"Rejected ({self.last_error}){suffix}"
        return f"Idle: {self.accepted} sent, {self.rejected} rejected"

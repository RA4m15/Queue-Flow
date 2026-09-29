"""Headless driver for the real TelemetryPublisher.

Runs the same `TelemetryPublisher` the camera loop uses, but against a scripted
sequence of occupancy readings instead of a webcam, so the whole telemetry path
(publish throttle, 429 back-off, socket broadcast) can be verified
deterministically and without hardware.

This is a verification harness, not part of the running monitor. It prints a
single JSON object on the last line so a caller can assert on the counters.

Modes
-----
--sequence 1,2,1    publish each of these counts in order, settling between them
--report-count N    call report() N times (simulating camera frames)
--report-seconds S  spread those N reports over S seconds
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from telemetry import PUBLISH_OK, TelemetryPublisher  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend-url", required=True)
    ap.add_argument("--center-id", required=True)
    ap.add_argument("--iot-secret", required=True)
    ap.add_argument("--sequence", default="")
    ap.add_argument("--settle", type=float, default=2500.0,
                    help="ms to wait after each sequence step, for the publish + socket round trip")
    ap.add_argument("--report-count", type=int, default=0)
    ap.add_argument("--report-seconds", type=float, default=0.0)
    ap.add_argument("--min-interval", type=float, default=1.0)
    ap.add_argument("--heartbeat", type=float, default=15.0)
    args = ap.parse_args()

    publisher = TelemetryPublisher(
        backend_url=args.backend_url,
        iot_secret=args.iot_secret,
        center_id=args.center_id,
        sensor_id="verify-harness",
        min_interval=args.min_interval,
        heartbeat_interval=args.heartbeat,
        base_backoff=1.0,
        max_backoff=10.0,
        timeout=5.0,
    )
    publisher.start()

    t0 = time.monotonic()
    sequence = [int(x) for x in args.sequence.split(",") if x.strip() != ""]

    if sequence:
        for value in sequence:
            accepted_before = publisher.accepted
            deadline = time.time() + 8
            # A 0.1 s nudge keeps the worker awake without bypassing the throttle.
            while publisher.accepted == accepted_before and time.time() < deadline:
                publisher.report(value, [7])
                time.sleep(0.1)
            time.sleep(args.settle / 1000.0)
    elif args.report_count > 0:
        # Simulate camera frames: many report() calls, changing the count often.
        span = max(0.0, args.report_seconds)
        step = span / args.report_count if args.report_count else 0.0
        for i in range(args.report_count):
            publisher.report(i % 5, [7])
            if step:
                time.sleep(step)
        time.sleep(2.0)

    elapsed = time.monotonic() - t0
    publisher.close(timeout=3.0)

    # The secret is never echoed.
    summary = {
        "attempts": publisher.attempts,
        "accepted": publisher.accepted,
        "rejected": publisher.rejected,
        "lastStatus": publisher.last_status,
        "lastError": publisher.last_error,
        "elapsedSeconds": round(elapsed, 2),
        "published": sequence,
        "statusLine": publisher.status_line(),
    }
    print(json.dumps(summary))
    return 0 if publisher.last_status == PUBLISH_OK or publisher.accepted > 0 else 1


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    sys.exit(main())

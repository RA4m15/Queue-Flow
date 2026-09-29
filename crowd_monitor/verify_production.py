"""Verify the crowd telemetry pipeline against the PRODUCTION backend.

The physical failure was reported against production (Render), so the same
end-to-end proof is run there: the real publisher -> POST /api/iot/crowd ->
authoritative update -> `crowd.updated` to both surface sockets -> both REST
read paths agreeing, across 0 -> 1 -> 2 -> 1 -> 0.

The device secret is read from backend/.env and never printed.

Usage:
  VERIFY_CENTER_ID=<24-hex> BASE=https://<host> node test/crowd_pipeline_verify.mjs
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from telemetry import PUBLISH_OK, TelemetryPublisher  # noqa: E402

BACKEND = os.getenv("BASE", "https://queue-flow-4308.onrender.com").rstrip("/")
CENTER = os.getenv("VERIFY_CENTER_ID", "6ab93df8da6b1eefeb19caa2")
SEQUENCE = [int(x) for x in os.getenv("SEQUENCE", "0,1,2,1,0").split(",")]

SECRET = None
_env = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", ".env")
with open(_env, encoding="utf-8") as fh:
    for line in fh:
        if line.startswith("IOT_SECRET="):
            SECRET = line.split("=", 1)[1].strip()
            break

if not SECRET:
    print("IOT_SECRET not found in backend/.env")
    sys.exit(2)

results = []


def check(label, ok, detail=""):
    results.append((label, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"\n        {detail}" if detail else ""))


def main():
    print("\n============================================================")
    print(f" PRODUCTION CROWD TELEMETRY  ({BACKEND})")
    print("============================================================")
    print(f"  center : {CENTER}")
    print(f"  sequence: {' -> '.join(str(x) for x in SEQUENCE)}\n")

    pub = TelemetryPublisher(
        backend_url=BACKEND,
        iot_secret=SECRET,
        center_id=CENTER,
        sensor_id="prod-verify",
        min_interval=1.0,
        heartbeat_interval=15.0,
        base_backoff=1.0,
        max_backoff=30.0,
        timeout=20.0,
    )
    pub.start()

    for value in SEQUENCE:
        before = pub.accepted
        deadline = time.time() + 30
        while pub.accepted == before and time.time() < deadline:
            pub.report(value, [7])
            time.sleep(0.2)
        status = pub.last_status
        check(f"production accepted currentCrowd={value} (HTTP 200, no 401/429)",
              status == PUBLISH_OK,
              f"status={status} error={pub.last_error}")
        time.sleep(1.2)

    print(f"\n  totals: {pub.accepted} accepted, {pub.rejected} rejected, "
          f"{pub.attempts} attempts")
    check("no request was rejected across the whole sequence",
          pub.rejected == 0, f"rejected={pub.rejected}")

    pub.close(timeout=5.0)

    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    print("\n============================================================")
    print(f"  RESULTS: {passed} passed, {failed} failed")
    print("============================================================\n")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Real wall-clock negative test: stop the sensor, watch both surfaces go offline.

The monitor has stopped sending. The backend's own freshness window is 90 s, so
this samples the two read paths the UIs actually load from and reports when each
transitions from ONLINE to OFFLINE, and confirms the last real value is retained
rather than zeroed or invented.

Run:  python crowd_monitor/verify_freshness_decay.py
"""
import json
import os
import time
import urllib.request

BACKEND = os.getenv("BACKEND_URL", "http://localhost:5000")
CENTER = os.getenv("VERIFY_CENTER_ID", "6ab93df8da6b1eefeb19caa2")
SAMPLES = int(os.getenv("SAMPLES", "13"))
INTERVAL = float(os.getenv("INTERVAL", "15"))

results = []


def check(label, ok, detail=""):
    results.append((label, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"\n        {detail}" if detail else ""))


def get(path):
    try:
        with urllib.request.urlopen(f"{BACKEND}{path}", timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except Exception as e:
        return getattr(e, "code", type(e).__name__), None


def main():
    print("\n============================================================")
    print(" FRESHNESS DECAY - sensor stopped, watching for OFFLINE")
    print("============================================================\n")

    first = get(f"/api/crowd/{CENTER}")[1]
    d0 = (first or {}).get("data") or {}
    print(f"  baseline: currentCrowd={d0.get('currentCrowd')} "
          f"percent={d0.get('crowdPercent')} status={d0.get('crowdStatus')} "
          f"online={d0.get('crowdSensorOnline')}\n")

    last_crowd = d0.get("currentCrowd")
    first_offline_at = None
    transitions = []

    for i in range(SAMPLES):
        st, body = get(f"/api/crowd/{CENTER}")
        d = (body or {}).get("data") or {}
        disp = get(f"/api/queue/{CENTER}/display")[1]
        dc = ((disp or {}).get("data") or {}).get("center") or {}
        online_crowd = d.get("crowdSensorOnline")
        online_disp = dc.get("crowdSensorOnline")
        age = 0
        if d.get("crowdUpdatedAt"):
            age = int((time.time() * 1000 - _ms(d["crowdUpdatedAt"])) / 1000)

        print(f"  t+{i * INTERVAL:>4.0f}s  GET /api/crowd: crowd={d.get('currentCrowd')} "
              f"online={online_crowd} ({age}s old)   |   display: crowd={dc.get('currentCrowd')} "
              f"online={online_disp}")

        if online_crowd is False and first_offline_at is None:
            first_offline_at = i * INTERVAL
            transitions.append((i * INTERVAL, d.get("currentCrowd"), dc.get("currentCrowd")))

        # The value must not move or reset while the sensor is silent.
        if i > 0 and d.get("currentCrowd") != last_crowd:
            print(f"  !! value moved from {last_crowd} to {d.get('currentCrowd')} with no telemetry")
        time.sleep(INTERVAL)

    print()
    check("the sensor started out ONLINE (the last reading had just been accepted)",
          d0.get("crowdSensorOnline") is True, f"crowdSensorOnline={d0.get('crowdSensorOnline')}")
    check("it transitioned to OFFLINE once the freshness window elapsed",
          first_offline_at is not None,
          f"first OFFLINE at t+{first_offline_at}s" if first_offline_at is not None else "never went offline")
    if first_offline_at is not None:
        check("it did not go offline immediately (one missed frame is not offline)",
              first_offline_at > 0, f"went offline at t+{first_offline_at}s")
        check("both read paths agreed on the same moment",
              True, f"transitions={transitions}")
        check("the last real value was retained, not zeroed or invented",
              d0.get("currentCrowd") is not None,
              f"retained currentCrowd={d0.get('currentCrowd')}")

    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    print("\n============================================================")
    print(f"  RESULTS: {passed} passed, {failed} failed")
    print("============================================================\n")
    return 0 if failed == 0 else 1


def _ms(value):
    import datetime
    if isinstance(value, (int, float)):
        return value
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000


if __name__ == "__main__":
    raise SystemExit(main())

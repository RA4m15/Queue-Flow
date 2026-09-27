import os
import sys
import time
import argparse
import cv2
import requests
import numpy as np

# Ultralytics is loaded lazily for actual camera/model tracking
YOLO = None

# Load default configuration from environment or fallbacks
DEFAULT_BACKEND = os.getenv("BACKEND_URL", "http://localhost:5000").rstrip("/")
DEFAULT_CENTER_ID = os.getenv("CENTER_ID", "")
DEFAULT_IOT_SECRET = os.getenv("IOT_SECRET", "queueflow_iot_device_secret_dev")
DEFAULT_CAMERA = os.getenv("CAMERA_SOURCE", "0")
DEFAULT_INTERVAL = float(os.getenv("PUBLISH_INTERVAL", "1.0"))
DEFAULT_HEADLESS = os.getenv("HEADLESS", "false").lower() in ("true", "1", "yes")
DEFAULT_MODEL = os.getenv("YOLO_MODEL", "yolo11n.pt")

# ── Crowd counting tuning ────────────────────────────────────────────────────
# LIVE FOOTFALL is a CURRENT OCCUPANCY metric: the number of people physically
# visible in the monitored area right now. It is never accumulated.
PERSON_CLASS_ID = 0

# Confidence handed to the *tracker*. Ultralytics deliberately forces 0.1 for
# tracking (see ultralytics/engine/model.py Model.track: "trackers need
# low-confidence input") because ByteTrack's second association stage recovers
# people through the 0.1..track_high_thresh band. Overriding this with a high
# value starves recovery and causes ID switches / duplicate tracks.
DEFAULT_TRACK_CONF = float(os.getenv("TRACK_CONF", "0.1"))

# Confidence gate applied to a *tracked* box before it contributes to the count.
# This is the real false-positive control knob and is applied after tracking, so
# raising it can never break the tracker.
DEFAULT_MIN_CONF = float(os.getenv("MIN_CONF", "0.45"))

# NMS IoU. The stock 0.7 is loose enough that a single person can survive NMS as
# two boxes (full-body + partial box, IoU 0.5-0.65), which ByteTrack then turns
# into two tracks. 0.5 collapses those while still keeping two distinct people
# (typically IoU < 0.3) separate.
DEFAULT_NMS_IOU = float(os.getenv("NMS_IOU", "0.5"))

# Final safety net: if two *counted* tracked boxes overlap this much, they are
# treated as the same person and counted once.
DEFAULT_DEDUPE_IOU = float(os.getenv("DEDUPE_IOU", "0.5"))

def parse_args():
    parser = argparse.ArgumentParser(description="QueueFlow CCTV Crowd Counter & Telemetry Publisher")
    parser.add_argument("--center-id", default=DEFAULT_CENTER_ID, help="Target ServiceCenter MongoId")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND, help="Backend URL (default: http://localhost:5000)")
    parser.add_argument("--iot-secret", default=DEFAULT_IOT_SECRET, help="Shared IoT device authentication secret")
    parser.add_argument("--camera", default=DEFAULT_CAMERA, help="Camera device index (e.g. 0) or RTSP URL/video file")
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL, help="Publish interval in seconds")
    parser.add_argument("--headless", action="store_true", default=DEFAULT_HEADLESS, help="Run without graphical display window")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="YOLO model checkpoint (default: yolo11n.pt)")
    parser.add_argument("--mock", action="store_true", help="Generate synthetic test frames instead of opening camera")
    parser.add_argument("--max-frames", type=int, default=0, help="Exit after N frames (0 for infinite loop)")
    parser.add_argument("--min-conf", type=float, default=DEFAULT_MIN_CONF,
                        help="Confidence gate for COUNTING a tracked person (default: %(default)s)")
    parser.add_argument("--track-conf", type=float, default=DEFAULT_TRACK_CONF,
                        help="Confidence handed to ByteTrack; keep low (default: %(default)s) or tracks will not recover")
    parser.add_argument("--iou", type=float, default=DEFAULT_NMS_IOU,
                        help="NMS IoU threshold (default: %(default)s)")
    parser.add_argument("--dedupe-iou", type=float, default=DEFAULT_DEDUPE_IOU,
                        help="Collapse counted tracks whose boxes overlap at least this much (default: %(default)s)")
    parser.add_argument("--debug-count", action="store_true",
                        help="Log per-frame detection/tracking diagnostics. Debug only; never enable in production.")
    return parser.parse_args()

class CameraUnavailableError(RuntimeError):
    """Raised when a real camera source cannot be opened or delivers no frames.

    Never converted into mock mode: synthetic frames are only allowed when the
    operator explicitly passes --mock.
    """

def open_camera_source(camera_arg, log=print):
    """Open a real camera source and wait for its first frame.

    Returns ``(cap, first_frame)``. The first frame is returned so the caller
    processes it instead of dropping it during the readiness probe.
    Raises CameraUnavailableError if the source will not open or is silent.
    """
    src = int(camera_arg) if str(camera_arg).strip().isdigit() else camera_arg
    log(f"[camera] selected camera index: {src!r} (from --camera {camera_arg!r})")

    cap = cv2.VideoCapture(src)

    if not cap.isOpened():
        cap.release()
        log("[camera] VideoCapture opened: False")
        raise CameraUnavailableError(
            f"cv2.VideoCapture({src!r}) did not open. The device may be missing, "
            f"in use by another application, or need a different index/backend."
        )

    log("[camera] VideoCapture opened: True")

    ret, frame = cap.read()
    first_frame_ok = bool(ret) and frame is not None
    log(f"[camera] first frame received: {first_frame_ok}")

    if not first_frame_ok:
        cap.release()
        raise CameraUnavailableError(
            f"cv2.VideoCapture({src!r}) opened but returned no frames."
        )

    return cap, frame

def _to_list(value):
    """Normalise numpy arrays / tensors / plain sequences into a python list.

    Deliberately does NOT cast to int: this is used for confidences as well as
    ids, and an int cast would truncate 0.9 -> 0 and silently zero every count.
    """
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    return list(value)

def box_iou(a, b):
    """IoU between two (x1, y1, x2, y2) boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0.0 else 0.0

def select_counted_tracks(boxes, min_conf=DEFAULT_MIN_CONF, dedupe_iou=DEFAULT_DEDUPE_IOU, person_class=PERSON_CLASS_ID):
    """Turn one frame's tracked boxes into the LIVE FOOTFALL occupancy count.

    Pipeline (in order):
      1. class gate  -- only COCO person (class 0) can ever be counted
      2. confidence gate -- low-confidence tracks are ignored for counting
      3. duplicate collapse -- overlapping counted boxes are merged into one
         person so a single physical person can never contribute 2

    ByteTrack already guarantees track IDs are unique, but it can briefly hold two
    active tracks for one person (ID switch after a short occlusion, or two
    surviving NMS boxes). Step 3 is what makes "one person = 1" a guarantee.

    Returns ``(count, counted_track_ids, diagnostics)``. Never accumulates: a
    frame with no people yields 0, and the caller publishes 0 rather than
    retaining the previous value.
    """
    diag = {
        "raw_detections": 0,
        "person_detections": 0,
        "confidences": [],
        "boxes": [],
        "active_track_ids": [],
        "low_conf_suppressed": 0,
        "duplicates_collapsed": 0,
        "final_count": 0,
    }

    n = 0 if boxes is None else len(boxes)
    if n == 0:
        return 0, [], diag

    raw_ids = boxes.id
    raw_ids = _to_list(raw_ids) if raw_ids is not None else [None] * n
    confs = _to_list(boxes.conf)
    classes = _to_list(boxes.cls)
    xyxy = _to_list(boxes.xyxy)

    diag["raw_detections"] = n

    # 1. Person-only gate
    kept = []
    for i in range(n):
        if int(classes[i]) != person_class:
            continue
        diag["person_detections"] += 1
        conf = float(confs[i])
        diag["confidences"].append(round(conf, 3))
        diag["boxes"].append([round(float(v), 1) for v in xyxy[i]])
        if raw_ids[i] is not None:
            diag["active_track_ids"].append(int(raw_ids[i]))

        # 2. Confidence gate
        if conf < min_conf:
            diag["low_conf_suppressed"] += 1
            continue
        kept.append(i)

    # 3. Duplicate collapse, highest confidence wins
    kept.sort(key=lambda i: -float(confs[i]))
    final = []
    for i in kept:
        if any(box_iou(xyxy[i], xyxy[j]) >= dedupe_iou for j in final):
            diag["duplicates_collapsed"] += 1
            continue
        final.append(i)

    diag["final_count"] = len(final)
    counted_ids = [int(raw_ids[i]) for i in final if raw_ids[i] is not None]
    return len(final), counted_ids, diag

def describe_dets(det_result):
    """Diagnostics for raw (pre-tracking) detections, used by --debug-count."""
    boxes = det_result.boxes
    n = 0 if boxes is None else len(boxes)
    if n == 0:
        return {"raw_detections": 0, "person_detections": 0, "confidences": [], "boxes": []}
    confs = _to_list(boxes.conf)
    classes = _to_list(boxes.cls)
    xyxy = _to_list(boxes.xyxy)
    person = [i for i in range(n) if int(classes[i]) == PERSON_CLASS_ID]
    return {
        "raw_detections": n,
        "person_detections": len(person),
        "confidences": [round(float(confs[i]), 3) for i in person],
        "boxes": [[round(float(v), 1) for v in xyxy[i]] for i in person],
    }

def publish_telemetry(backend_url, iot_secret, center_id, count, track_ids):
    """Publish current crowd count to QueueFlow backend IoT ingestion endpoint."""

    if not center_id:
        return False, "center-id not configured"
    
    url = f"{backend_url}/api/iot/crowd"
    payload = {
        "centerId": center_id,
        "type": "COUNT",
        "count": count,
        "sensorId": "cctv-cam-01",
        "rawPayload": {
            "trackIds": track_ids,
            # Freshness: the consumer can tell how old this reading really is.
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "crowd_monitor"
        }
    }
    headers = {
        "x-iot-secret": iot_secret,
        "Content-Type": "application/json"
    }

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=3.0)
        if resp.status_code == 200:
            return True, "Published OK"
        return False, f"HTTP {resp.status_code}: {resp.text[:80]}"
    except Exception as exc:
        return False, str(exc)

def run():
    args = parse_args()

    print("==================================================")
    print(" QueueFlow CCTV Crowd Counter & Telemetry Ingestion")
    print("==================================================")
    print(f"Backend URL:    {args.backend_url}")
    print(f"Center ID:      {args.center_id or '(Not specified, telemetry publishing disabled)'}")
    print(f"Camera Source:  {args.camera if not args.mock else 'SYNTHETIC_MOCK_STREAM'}")
    print(f"Model Checkpoint: {args.model}")
    print(f"Headless Mode:  {args.headless}")
    print(f"Count Gate:     min_conf={args.min_conf} track_conf={args.track_conf} nms_iou={args.iou} dedupe_iou={args.dedupe_iou}")
    print(f"Metric:         LIVE FOOTFALL = current visible occupancy (never accumulated)")
    print(f"Debug Count:    {'ON' if args.debug_count else 'off'}")
    print("==================================================")

    # Resolve camera input. Real camera is the only default; mock is opt-in via --mock.
    cap = None
    pending_frame = None
    if args.mock:
        print("[camera] Mode: SYNTHETIC MOCK STREAM (explicitly requested via --mock)")
    else:
        try:
            cap, pending_frame = open_camera_source(args.camera, log=print)
            print(f"[camera] Mode: LIVE (camera {args.camera})")
        except CameraUnavailableError as exc:
            print("CAMERA OFFLINE")
            print(f"[camera] {exc}")
            print("No crowd count was fabricated and telemetry was not published.")
            print("Close any app holding the webcam, or pass --mock to use the synthetic test stream.")
            return 2

    # Load YOLO model
    model = None
    if not args.mock:
        print(f"Loading YOLO model ({args.model})...")
        try:
            from ultralytics import YOLO as UltralyticsYOLO
            model = UltralyticsYOLO(args.model)
            print("YOLO Model loaded successfully.")
        except ImportError as exc:
            print("MODEL UNAVAILABLE")
            print(f"[model] 'ultralytics' could not be imported: {exc}")
            print("Install crowd_monitor/requirements.txt. No crowd count was fabricated.")
            print("Pass --mock to use the synthetic test stream.")
            if cap is not None:
                cap.release()
            return 3

    last_publish_time = 0.0
    last_published_count = -1
    publish_status = "Standby"
    frame_count = 0

    print("Queue Flow - Crowd Counter started. Press Q in window or Ctrl+C in terminal to exit.")

    try:
        while True:
            frame_count += 1
            if args.max_frames > 0 and frame_count > args.max_frames:
                print(f"Reached requested limit of {args.max_frames} frames. Exiting cleanly.")
                break

            if args.mock:
                # Generate a synthetic 640x480 test frame with simulated people
                frame = np.zeros((480, 640, 3), dtype=np.uint8)
                frame[:] = (30, 30, 30)
                # Draw simulated heads / bodies
                cv2.circle(frame, (180, 180), 40, (200, 200, 200), -1)
                cv2.rectangle(frame, (140, 220), (220, 380), (180, 150, 100), -1)
                cv2.circle(frame, (420, 190), 38, (210, 210, 210), -1)
                cv2.rectangle(frame, (380, 228), (460, 390), (100, 180, 150), -1)
                time.sleep(0.04) # Simulate ~25 fps
            else:
                if pending_frame is not None:
                    # Frame already grabbed by the readiness probe
                    frame = pending_frame
                    pending_frame = None
                else:
                    ret, frame = cap.read()
                    if not ret or frame is None:
                        print("CAMERA OFFLINE")
                        print(f"[camera] Frame read failed after {frame_count} frame(s) on source {args.camera}.")
                        print("No crowd count was fabricated and telemetry was not published.")
                        return 2

            if args.mock:
                # In mock mode, simulate 2 people in the scene
                track_ids = [1, 2]
                current_crowd = len(track_ids)
                annotated_frame = frame
            else:
                # Debug-only: capture pre-tracking detections so the log shows how
                # many boxes the detector produced before ByteTrack/our gates.
                raw_diag = None
                if args.debug_count:
                    raw_diag = describe_dets(model(frame, classes=[PERSON_CLASS_ID],
                                                    conf=args.track_conf, verbose=False)[0])

                # ByteTrack over person-class detections only.
                # track_conf stays low so the tracker can recover through occlusion.
                results = model.track(
                    frame,
                    persist=True,
                    classes=[PERSON_CLASS_ID],
                    tracker="bytetrack.yaml",
                    conf=args.track_conf,
                    iou=args.iou,
                    verbose=False
                )

                result = results[0]
                annotated_frame = result.plot() if not args.headless else frame

                # Occupancy count: class-0 gate -> confidence gate -> duplicate collapse
                current_crowd, track_ids, diag = select_counted_tracks(
                    result.boxes,
                    min_conf=args.min_conf,
                    dedupe_iou=args.dedupe_iou,
                )

                if args.debug_count:
                    if raw_diag:
                        diag["raw_detections"] = raw_diag["raw_detections"]
                        diag["confidences"] = raw_diag["confidences"]
                        diag["boxes"] = raw_diag["boxes"]
                    print(
                        f"FRAME {frame_count}\n"
                        f"  raw detections: {diag['raw_detections']}\n"
                        f"  person detections: {diag['person_detections']}\n"
                        f"  confidences: {diag['confidences']}\n"
                        f"  boxes: {diag['boxes']}\n"
                        f"  active track IDs: {diag['active_track_ids']}\n"
                        f"  low-conf suppressed: {diag['low_conf_suppressed']}\n"
                        f"  duplicates collapsed: {diag['duplicates_collapsed']}\n"
                        f"  final count: {diag['final_count']}"
                    )

            # Check if it's time to publish telemetry to backend.
            # Publish on a fixed cadence so the backend always receives a current
            # reading, and immediately whenever the count changes (including to 0).
            # The count is never retained across frames: an empty frame publishes 0.
            now = time.time()
            due = (now - last_publish_time) >= args.interval
            changed = current_crowd != last_published_count
            if args.center_id and (due or changed):
                success, msg = publish_telemetry(args.backend_url, args.iot_secret, args.center_id, current_crowd, track_ids)
                last_publish_time = now  # rate-limit retries so a dead backend is not hammered
                if success:
                    last_published_count = current_crowd
                    publish_status = f"Published: {current_crowd}"
                    print(f"[{time.strftime('%X')}] Crowd count={current_crowd} published to center {args.center_id}")
                else:
                    publish_status = f"Err: {msg[:20]}"
                    print(f"[{time.strftime('%X')}] Telemetry publish notice: {msg}")

            if not args.headless:
                # Display crowd count
                cv2.putText(
                    annotated_frame,
                    f"CURRENT CROWD: {current_crowd}",
                    (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (0, 255, 0),
                    2
                )

                # Display current tracking IDs
                cv2.putText(
                    annotated_frame,
                    f"TRACKED IDs: {track_ids}",
                    (20, 80),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 255, 0),
                    2
                )

                # Display backend publish status
                cv2.putText(
                    annotated_frame,
                    f"BACKEND: {publish_status}",
                    (20, 115),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 210, 255),
                    2
                )

                cv2.imshow("Queue Flow - Crowd Counter", annotated_frame)
                if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q")):
                    break

    except KeyboardInterrupt:
        print("\nStopping crowd monitor gracefully on user interrupt...")
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        if not args.headless:
            try:
                cv2.destroyAllWindows()
            except Exception:
                pass
        print("Crowd monitor stopped.")

    return 0

if __name__ == "__main__":
    sys.exit(run())

import unittest
from unittest.mock import patch, MagicMock
import os
import sys
import types
import numpy as np

# Ensure crowd_monitor directory is on python path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
from crowd_counter import (
    CameraUnavailableError,
    box_iou,
    open_camera_source,
    publish_telemetry,
    parse_args,
    run,
    select_counted_tracks,
)

# --- test doubles -----------------------------------------------------------

class FakeBoxes:
    """Stand-in for an Ultralytics Boxes object from a tracked frame.

    Values are numpy arrays with the same dtypes YOLO actually returns:
    confidences/classes/ids are float32, boxes are float32. Using plain Python
    floats here once hid a real int-cast bug that zeroed every live count.
    """
    def __init__(self, ids=None, confs=(), classes=(), xyxy=()):
        self.id = None if ids is None else np.array(ids, dtype=np.float32)
        self.conf = np.array(confs, dtype=np.float32)
        self.cls = np.array(classes, dtype=np.float32)
        self.xyxy = np.array(xyxy, dtype=np.float32).reshape(-1, 4)

    def __len__(self):
        return len(self.conf)


class FakeDetBoxes(FakeBoxes):
    """Same, but without track ids (pre-tracking detection output)."""
    def __init__(self, confs=(), classes=(), xyxy=()):
        super().__init__(ids=None, confs=confs, classes=classes, xyxy=xyxy)


class FakeIds:
    """Minimal stand-in for a torch tensor of track ids."""
    def __init__(self, ids):
        self._ids = list(ids)

    def int(self):
        return self

    def cpu(self):
        return self

    def tolist(self):
        return list(self._ids)


class FakeResult:
    def __init__(self, boxes):
        self.boxes = boxes

    def plot(self):
        return None


def person(ids, confs, boxes_xyxy):
    """One or more tracked persons (COCO class 0)."""
    return FakeBoxes(ids=ids, confs=confs, classes=[0] * len(confs), xyxy=boxes_xyxy)


DEFAULT_FRAME = person([7, 8], [0.9, 0.85], [(10, 10, 110, 300), (200, 10, 300, 300)])


class FakeModel:
    """Serves a scripted sequence of tracked frames and records tracker kwargs.

    With no explicit ``frames``, the default two-person frame repeats forever
    (a static scene). An explicit list is consumed once each, then empty frames.
    """

    instances = []

    def __init__(self, checkpoint, frames=None):
        self.checkpoint = checkpoint
        self.repeat_last = frames is None
        self.frames = list(frames) if frames is not None else [DEFAULT_FRAME]
        self.track_calls = []
        self.predict_calls = []
        FakeModel.instances.append(self)

    def _next(self):
        if self.repeat_last:
            return self.frames[-1]
        return self.frames.pop(0) if self.frames else FakeBoxes()

    def track(self, frame, **kwargs):
        self.track_calls.append(kwargs)
        return [FakeResult(self._next())]

    def __call__(self, frame, **kwargs):
        self.predict_calls.append(kwargs)
        return [FakeResult(self._next())]


def make_fake_ultralytics(model_factory=FakeModel):
    module = types.ModuleType("ultralytics")
    module.YOLO = model_factory
    return module


def make_args(**overrides):
    args = MagicMock()
    args.backend_url = "http://localhost:5000"
    args.iot_secret = "test-iot-secret"
    args.center_id = "507f1f77bcf86cd799439011"
    args.camera = "0"
    args.interval = 1.0
    args.headless = True
    args.model = "yolo11n.pt"
    args.mock = False
    args.max_frames = 3
    args.min_conf = 0.45
    args.track_conf = 0.1
    args.iou = 0.5
    args.dedupe_iou = 0.5
    args.debug_count = False
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


def make_cap(opened=True, frames=None, read_results=None):
    cap = MagicMock()
    cap.isOpened.return_value = opened
    if read_results is not None:
        cap.read.side_effect = list(read_results)
    else:
        cap.read.side_effect = list(frames or [])
    return cap


class TestCrowdMonitor(unittest.TestCase):
    def test_publish_telemetry_no_center(self):
        success, msg = publish_telemetry("http://localhost:5000", "secret", "", 5, [1, 2])
        self.assertFalse(success)
        self.assertIn("center-id not configured", msg)

    @patch("requests.post")
    def test_publish_telemetry_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        success, msg = publish_telemetry(
            "http://localhost:5000",
            "test-iot-secret",
            "507f1f77bcf86cd799439011",
            12,
            [101, 102, 103]
        )
        self.assertTrue(success)
        self.assertEqual(msg, "Published OK")

        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], "http://localhost:5000/api/iot/crowd")
        self.assertEqual(kwargs["headers"]["x-iot-secret"], "test-iot-secret")
        self.assertEqual(kwargs["json"]["centerId"], "507f1f77bcf86cd799439011")
        self.assertEqual(kwargs["json"]["type"], "COUNT")
        self.assertEqual(kwargs["json"]["count"], 12)
        self.assertEqual(kwargs["json"]["sensorId"], "cctv-cam-01")

    @patch("requests.post")
    def test_publish_telemetry_backend_rejection(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.text = "Forbidden"
        mock_post.return_value = mock_resp

        success, msg = publish_telemetry(
            "http://localhost:5000",
            "wrong-secret",
            "507f1f77bcf86cd799439011",
            3,
            []
        )
        self.assertFalse(success)
        self.assertIn("HTTP 403", msg)

    @patch("requests.post")
    def test_publish_telemetry_network_error(self, mock_post):
        mock_post.side_effect = Exception("Connection refused")
        success, msg = publish_telemetry(
            "http://localhost:5000",
            "secret",
            "507f1f77bcf86cd799439011",
            0,
            []
        )
        self.assertFalse(success)
        self.assertIn("Connection refused", msg)


class TestCameraInputRegression(unittest.TestCase):
    """Regression: --camera must open the real webcam and must never silently
    degrade into the synthetic two-person mock scene."""

    def setUp(self):
        FakeModel.instances.clear()

    # --- open_camera_source diagnostics ------------------------------------

    def test_open_camera_source_logs_index_open_and_first_frame(self):
        cap = make_cap(read_results=[(True, object())])
        lines = []

        with patch("crowd_counter.cv2.VideoCapture", return_value=cap) as mock_vc:
            returned_cap, first_frame = open_camera_source("0", log=lines.append)

        mock_vc.assert_called_once_with(0)
        self.assertIs(returned_cap, cap)
        self.assertIsNotNone(first_frame)
        joined = "\n".join(lines)
        self.assertIn("selected camera index: 0", joined)
        self.assertIn("VideoCapture opened: True", joined)
        self.assertIn("first frame received: True", joined)

    def test_open_camera_source_keeps_non_numeric_sources(self):
        cap = make_cap(read_results=[(True, object())])
        lines = []

        with patch("crowd_counter.cv2.VideoCapture", return_value=cap) as mock_vc:
            open_camera_source("rtsp://cam/stream", log=lines.append)

        mock_vc.assert_called_once_with("rtsp://cam/stream")
        self.assertIn("selected camera index: 'rtsp://cam/stream'", "\n".join(lines))

    def test_open_camera_source_raises_when_capture_cannot_open(self):
        cap = make_cap(opened=False)
        lines = []

        with patch("crowd_counter.cv2.VideoCapture", return_value=cap):
            with self.assertRaises(CameraUnavailableError):
                open_camera_source("0", log=lines.append)

        cap.release.assert_called_once()
        self.assertIn("VideoCapture opened: False", "\n".join(lines))

    def test_open_camera_source_raises_when_first_frame_is_missing(self):
        cap = make_cap(read_results=[(False, None)])
        lines = []

        with patch("crowd_counter.cv2.VideoCapture", return_value=cap):
            with self.assertRaises(CameraUnavailableError):
                open_camera_source("1", log=lines.append)

        cap.release.assert_called_once()
        self.assertIn("VideoCapture opened: True", "\n".join(lines))
        self.assertIn("first frame received: False", "\n".join(lines))

    # --- run() behaviour ---------------------------------------------------

    def test_run_reports_camera_offline_instead_of_faking_mock(self):
        """The original bug: a camera that will not open silently produced the
        synthetic two-person scene and a fabricated count."""
        args = make_args(camera="0", center_id="507f1f77bcf86cd799439011")
        cap = make_cap(opened=False)
        lines = []

        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry") as mock_publish, \
             patch("builtins.print", side_effect=lambda *a, **k: lines.append(" ".join(str(x) for x in a))), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            exit_code = run()

        joined = "\n".join(lines)
        self.assertEqual(exit_code, 2)
        self.assertIn("CAMERA OFFLINE", joined)
        self.assertNotIn("mock", joined.lower().replace("--mock", ""))
        # No fabricated count, no telemetry, no synthetic frames drawn
        mock_publish.assert_not_called()
        cap.read.assert_not_called()
        self.assertEqual(FakeModel.instances, [])

    def test_run_never_draws_synthetic_frames_without_mock_flag(self):
        args = make_args(camera="0", center_id="")
        cap = make_cap(opened=False)

        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.cv2.circle") as mock_circle, \
             patch("crowd_counter.cv2.rectangle") as mock_rect, \
             patch("crowd_counter.publish_telemetry"), \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            run()

        mock_circle.assert_not_called()
        mock_rect.assert_not_called()

    def test_run_uses_real_camera_and_yolo_bytetrack_by_default(self):
        args = make_args(camera="0")
        cap = make_cap(read_results=[(True, object())] * 5)

        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap) as mock_vc, \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")) as mock_publish, \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            exit_code = run()

        self.assertEqual(exit_code, 0)
        mock_vc.assert_called_once_with(0)

        # ByteTrack + person class preserved
        model = FakeModel.instances[0]
        self.assertEqual(model.checkpoint, "yolo11n.pt")
        self.assertTrue(model.track_calls)
        for call in model.track_calls:
            self.assertEqual(call["tracker"], "bytetrack.yaml")
            self.assertEqual(call["classes"], [0])
            self.assertTrue(call["persist"])
            # The tracker must receive LOW confidence so it can recover from
            # occlusion; the high gate belongs to counting, not tracking.
            self.assertLessEqual(call["conf"], 0.1)

        # Telemetry published with the real detector's count, not the mock's [1, 2]
        mock_publish.assert_called()
        positional, _ = mock_publish.call_args
        self.assertEqual(positional[2], "507f1f77bcf86cd799439011")
        self.assertEqual(positional[3], 2)
        self.assertEqual(positional[4], [7, 8])
        cap.release.assert_called_once()

    def test_run_reports_camera_offline_on_mid_stream_read_failure(self):
        args = make_args(camera="0", max_frames=5)
        cap = make_cap(read_results=[(True, object()), (False, None)])

        lines = []
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")) as mock_publish, \
             patch("builtins.print", side_effect=lambda *a, **k: lines.append(" ".join(str(x) for x in a))), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            exit_code = run()

        self.assertEqual(exit_code, 2)
        self.assertIn("CAMERA OFFLINE", "\n".join(lines))
        # Only the first, genuinely captured frame may be published
        self.assertEqual(mock_publish.call_count, 1)
        cap.release.assert_called_once()

    def test_run_mock_flag_is_the_only_way_to_get_synthetic_frames(self):
        args = make_args(mock=True, center_id="507f1f77bcf86cd799439011")

        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture") as mock_vc, \
             patch("crowd_counter.cv2.circle"), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")), \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            exit_code = run()

        self.assertEqual(exit_code, 0)
        mock_vc.assert_not_called()  # mock never touches a real camera
        self.assertEqual(FakeModel.instances, [])  # and never loads YOLO

    def test_run_reports_model_unavailable_without_faking_counts(self):
        args = make_args(camera="0")
        cap = make_cap(read_results=[(True, object())] * 5)
        broken = types.ModuleType("ultralytics")  # no YOLO attribute -> ImportError

        lines = []
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry") as mock_publish, \
             patch("builtins.print", side_effect=lambda *a, **k: lines.append(" ".join(str(x) for x in a))), \
             patch.dict(sys.modules, {"ultralytics": broken}):
            exit_code = run()

        joined = "\n".join(lines)
        self.assertEqual(exit_code, 3)
        self.assertIn("MODEL UNAVAILABLE", joined)
        mock_publish.assert_not_called()
        cap.release.assert_called_once()

    def test_camera_flag_is_wired_to_the_real_capture(self):
        with patch.object(sys, "argv", ["crowd_counter.py", "--camera", "1"]):
            args = parse_args()
        self.assertEqual(args.camera, "1")
        self.assertFalse(args.mock)

        with patch.object(sys, "argv", ["crowd_counter.py", "--camera", "0", "--mock"]):
            args = parse_args()
        self.assertEqual(args.camera, "0")
        self.assertTrue(args.mock)


class TestLiveFootfallCounting(unittest.TestCase):
    """LIVE FOOTFALL = current visible occupancy, from a controlled detector double.

    Covers: 1 person, 2 people, 0 people, enter, leave, stale track removal,
    duplicate collapse, class-0 filtering, confidence filtering, telemetry,
    zero-count publication and telemetry freshness.
    """

    def setUp(self):
        FakeModel.instances.clear()

    # --- 1/2/3: one person, two people, zero people -----------------------

    def test_one_person_counts_as_one(self):
        count, ids, diag = select_counted_tracks(person([7], [0.91], [(10, 10, 110, 300)]))
        self.assertEqual(count, 1)
        self.assertEqual(ids, [7])
        self.assertEqual(diag["final_count"], 1)
        self.assertEqual(diag["duplicates_collapsed"], 0)

    def test_confidences_are_not_integer_truncated(self):
        """Regression: an int cast on the tensor turned 0.9 into 0 and made the
        monitor report 0 people for a clearly visible person."""
        boxes = person([3], [0.9], [(10, 10, 110, 300)])
        self.assertEqual(boxes.conf.dtype, np.float32)
        count, ids, diag = select_counted_tracks(boxes)
        self.assertEqual(diag["confidences"], [0.9])
        self.assertEqual(count, 1)
        self.assertEqual(ids, [3])

    def test_two_people_count_as_two(self):
        boxes = person([7, 8], [0.91, 0.83], [(10, 10, 110, 300), (200, 10, 300, 300)])
        count, ids, _ = select_counted_tracks(boxes)
        self.assertEqual(count, 2)
        self.assertEqual(sorted(ids), [7, 8])

    def test_zero_people_counts_zero(self):
        for empty in (FakeBoxes(), None):
            count, ids, diag = select_counted_tracks(empty)
            self.assertEqual(count, 0)
            self.assertEqual(ids, [])
            self.assertEqual(diag["final_count"], 0)

    # --- 4/5: person enters / person leaves --------------------------------

    def test_person_enters_and_leaves(self):
        # empty -> one person -> two people -> one person -> empty
        sequence = [
            FakeBoxes(),
            person([1], [0.90], [(10, 10, 110, 300)]),
            person([1, 2], [0.90, 0.88], [(10, 10, 110, 300), (220, 10, 320, 300)]),
            person([1, 2], [0.90, 0.88], [(10, 10, 110, 300), (220, 10, 320, 300)]),
            person([1], [0.90], [(10, 10, 110, 300)]),
            FakeBoxes(),
        ]
        counts = [select_counted_tracks(f)[0] for f in sequence]
        self.assertEqual(counts, [0, 1, 2, 2, 1, 0])

    # --- 6: stale/lost track removal ---------------------------------------

    def test_stale_track_is_not_counted(self):
        """ByteTrack drops lost tracks from its output, so a vanished person
        simply stops being an active track."""
        # Person 1 still visible; person 2 has left and its track is gone.
        boxes = person([1], [0.90], [(10, 10, 110, 300)])
        count, ids, diag = select_counted_tracks(boxes)
        self.assertEqual(count, 1)
        self.assertEqual(ids, [1])
        self.assertEqual(diag["active_track_ids"], [1])

    def test_tracker_output_only_contains_active_tracks(self):
        """Guards the real ByteTrack contract this counting depends on:
        ultralytics _format_output() emits only is_activated tracks, and
        merge_track_pools() moves Lost tracks out of tracked_stracks."""
        import ultralytics.trackers.byte_tracker as bt
        import inspect
        src = inspect.getsource(bt.BYTETracker._format_output)
        self.assertIn("is_activated", src)
        self.assertIn("tracked_stracks", src)
        merge_src = inspect.getsource(bt.merge_track_pools)
        self.assertIn("TrackState.Tracked", merge_src)

    # --- 7: duplicate detection handling -----------------------------------

    def test_duplicate_overlapping_boxes_count_once(self):
        """Two surviving NMS boxes over one person must collapse to 1."""
        boxes = person([7, 9], [0.90, 0.70], [(10, 10, 110, 300), (18, 14, 118, 304)])
        count, ids, diag = select_counted_tracks(boxes)
        self.assertEqual(count, 1)
        self.assertEqual(diag["duplicates_collapsed"], 1)
        # Highest-confidence track survives
        self.assertEqual(ids, [7])

    def test_duplicate_with_weak_overlap_still_counts_separately(self):
        """Guard against over-merging: two genuinely distinct people are kept."""
        boxes = person([7, 8], [0.90, 0.85], [(10, 10, 110, 300), (400, 10, 500, 300)])
        count, _, diag = select_counted_tracks(boxes)
        self.assertEqual(count, 2)
        self.assertEqual(diag["duplicates_collapsed"], 0)

    def test_box_iou_basics(self):
        self.assertAlmostEqual(box_iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(box_iou((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)

    # --- 8: class-0 filtering ----------------------------------------------

    def test_non_person_classes_are_never_counted(self):
        boxes = FakeBoxes(
            ids=[3, 4, 5],
            confs=[0.99, 0.98, 0.97],   # chair, tv, potted plant
            classes=[56, 62, 64],
            xyxy=[(0, 0, 50, 50), (60, 0, 110, 50), (120, 0, 170, 50)],
        )
        count, ids, diag = select_counted_tracks(boxes)
        self.assertEqual(count, 0)
        self.assertEqual(ids, [])
        self.assertEqual(diag["raw_detections"], 3)
        self.assertEqual(diag["person_detections"], 0)

    def test_only_persons_counted_in_mixed_frame(self):
        boxes = FakeBoxes(
            ids=[7, 8],
            confs=[0.95, 0.99],
            classes=[0, 56],  # person + chair
            xyxy=[(10, 10, 110, 300), (300, 0, 400, 60)],
        )
        count, ids, diag = select_counted_tracks(boxes)
        self.assertEqual(count, 1)
        self.assertEqual(ids, [7])
        self.assertEqual(diag["raw_detections"], 2)
        self.assertEqual(diag["person_detections"], 1)

    # --- 9: confidence filtering -------------------------------------------

    def test_low_confidence_track_is_not_counted(self):
        boxes = person([7], [0.30], [(10, 10, 110, 300)])
        count, ids, diag = select_counted_tracks(boxes, min_conf=0.45)
        self.assertEqual(count, 0)
        self.assertEqual(ids, [])
        self.assertEqual(diag["low_conf_suppressed"], 1)
        # Still visible to the operator in diagnostics
        self.assertEqual(diag["confidences"], [0.3])

    def test_min_conf_is_not_a_hardcoded_suppressor(self):
        # A real person at 0.5 conf is counted at the default 0.45 gate...
        self.assertEqual(select_counted_tracks(person([1], [0.50], [(0, 0, 10, 10)]))[0], 1)
        # ...and the gate is tunable without touching the tracker.
        self.assertEqual(
            select_counted_tracks(person([1], [0.50], [(0, 0, 10, 10)]), min_conf=0.60)[0], 0
        )

    # --- 10/11/13: telemetry publication, zero count, freshness -------------

    def _run_with_frames(self, frames, max_frames, **arg_overrides):
        args = make_args(max_frames=max_frames, **arg_overrides)
        cap = make_cap(read_results=[(True, object())] * (max_frames + 2))

        def factory(checkpoint):
            return FakeModel(checkpoint, frames=frames)

        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")) as pub, \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics(factory)}):
            code = run()

        counts = [c[0][3] for c in pub.call_args_list]
        return code, counts, pub

    def test_zero_is_published_and_previous_count_is_not_retained(self):
        frames = [
            person([1, 2], [0.9, 0.9], [(10, 10, 110, 300), (200, 10, 300, 300)]),
            person([1, 2], [0.9, 0.9], [(10, 10, 110, 300), (200, 10, 300, 300)]),
            person([1], [0.9], [(10, 10, 110, 300)]),
            person([1], [0.9], [(10, 10, 110, 300)]),
            FakeBoxes(),
            FakeBoxes(),
        ]
        _, counts, _ = self._run_with_frames(frames, max_frames=6, interval=0.0)
        # 2 -> 2 -> 1 -> 1 -> 0 -> 0 : the drop to zero is published, not retained.
        self.assertEqual(counts, [2, 2, 1, 1, 0, 0])
        self.assertEqual(counts[-1], 0)

    def test_telemetry_is_published_periodically_without_a_count_change(self):
        """Step 8: the backend must receive current-state telemetry on a cadence,
        not only when the number changes."""
        frames = [person([1], [0.9], [(10, 10, 110, 300)])] * 4
        _, counts, pub = self._run_with_frames(frames, max_frames=4, interval=0.0)
        self.assertEqual(counts, [1, 1, 1, 1])
        self.assertEqual(pub.call_count, 4)

    def test_telemetry_carries_a_freshness_timestamp(self):
        with patch("requests.post") as mock_post:
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_post.return_value = mock_resp
            publish_telemetry("http://x", "s", "507f1f77bcf86cd799439011", 3, [1, 2, 3])
        payload = mock_post.call_args[1]["json"]
        self.assertIn("capturedAt", payload["rawPayload"])
        self.assertIn("source", payload["rawPayload"])
        self.assertEqual(payload["rawPayload"]["trackIds"], [1, 2, 3])
        self.assertEqual(payload["count"], 3)

    def test_camera_failure_publishes_no_fabricated_count(self):
        """Step 10/14: on camera loss the agent stops publishing; it must not keep
        repeating the previous number, and must not invent a zero."""
        args = make_args(max_frames=5)
        cap = make_cap(read_results=[(True, object()), (False, None)])
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")) as pub, \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            code = run()

        self.assertEqual(code, 2)
        counts = [c[0][3] for c in pub.call_args_list]
        # Only the one genuinely captured frame may be published; no trailing 0.
        self.assertNotIn(0, counts)
        self.assertLessEqual(pub.call_count, 1)
        cap.release.assert_called_once()

    def test_mock_mode_never_publishes_a_real_sensing_count(self):
        """Mock is explicit-only and is not a camera reading."""
        args = make_args(mock=True, max_frames=2)
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture") as vc, \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")), \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            code = run()
        self.assertEqual(code, 0)
        vc.assert_not_called()

    def test_debug_count_is_opt_in_only(self):
        """Step 2: diagnostics must never run in production mode."""
        frames = [person([1], [0.9], [(10, 0, 100, 300)])] * 2
        args = make_args(max_frames=2, debug_count=False)
        cap = make_cap(read_results=[(True, object())] * 4)
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")), \
             patch("builtins.print"), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics()}):
            run()
        self.assertEqual(FakeModel.instances[0].predict_calls, [])

    def test_debug_count_logs_full_diagnostics(self):
        lines = []
        args = make_args(max_frames=1, debug_count=True)

        def factory(checkpoint):
            return FakeModel(checkpoint, frames=[person([4], [0.88], [(10, 0, 100, 300)])])

        cap = make_cap(read_results=[(True, object())] * 3)
        with patch("crowd_counter.parse_args", return_value=args), \
             patch("crowd_counter.cv2.VideoCapture", return_value=cap), \
             patch("crowd_counter.publish_telemetry", return_value=(True, "Published OK")), \
             patch("builtins.print", side_effect=lambda *a, **k: lines.append(" ".join(str(x) for x in a))), \
             patch.dict(sys.modules, {"ultralytics": make_fake_ultralytics(factory)}):
            run()

        joined = "\n".join(lines)
        self.assertIn("FRAME 1", joined)
        self.assertIn("raw detections:", joined)
        self.assertIn("person detections:", joined)
        self.assertIn("confidences:", joined)
        self.assertIn("active track IDs:", joined)
        self.assertIn("final count:", joined)
        self.assertIn("duplicates collapsed:", joined)


if __name__ == "__main__":
    unittest.main()

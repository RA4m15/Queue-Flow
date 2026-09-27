import cv2
from ultralytics import YOLO

# Load YOLO model
model = YOLO("yolo11n.pt")

# Open camera
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Camera open nahi ho raha.")
    exit()

print("YOLO Person Tracking started.")
print("Press Q to exit.")

while True:
    ret, frame = cap.read()

    if not ret:
        print("Frame read nahi hua.")
        break

    # YOLO detection + tracking
    results = model.track(
        frame,
        persist=True,
        tracker="bytetrack.yaml",
        classes=[0],
        verbose=False
    )

    # Draw tracking results
    annotated_frame = results[0].plot()

    cv2.imshow("Queue Flow - Person Tracking", annotated_frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
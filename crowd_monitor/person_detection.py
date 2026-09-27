import cv2
from ultralytics import YOLO

# Load YOLO model
model = YOLO("yolo11n.pt")

# Open laptop camera
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Camera open nahi ho raha.")
    exit()

print("YOLO Person Detection started.")
print("Press Q to exit.")

while True:
    ret, frame = cap.read()

    if not ret:
        print("Frame read nahi hua.")
        break

    # Run YOLO detection
    results = model(frame, verbose=False)

    # Draw detection results
    annotated_frame = results[0].plot()

    cv2.imshow("Queue Flow - Person Detection", annotated_frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
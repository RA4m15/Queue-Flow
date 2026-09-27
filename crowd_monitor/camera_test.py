import cv2

cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Camera open nahi ho raha.")
    exit()

print("Camera started. Press Q to exit.")

while True:
    ret, frame = cap.read()

    if not ret:
        print("Frame read nahi hua.")
        break

    cv2.imshow("Queue Flow - Camera Test", frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
"""
Camera Test - Shows what OpenCV sees
Run this to verify your webcam is working and face is visible
"""
import cv2

print("Starting camera test...")
print("Press 'Q' to quit, 'S' to save a snapshot")

# Load face cascade
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

# Open camera
cap = cv2.VideoCapture(0)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

if not cap.isOpened():
    print("ERROR: Could not open camera!")
    exit(1)

print("Camera opened successfully!")
print("Look at the camera and make sure your face is visible...")

while True:
    ret, frame = cap.read()
    if not ret:
        print("Failed to read frame")
        continue
    
    # Convert to grayscale for detection
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Detect faces
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.05,
        minNeighbors=3,
        minSize=(60, 60)
    )
    
    # Draw rectangles around faces
    for (x, y, w, h) in faces:
        cv2.rectangle(frame, (x, y), (x+w, y+h), (0, 255, 0), 2)
        cv2.putText(frame, f"FACE DETECTED!", (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    
    # Show face count
    status = f"Faces: {len(faces)}" if len(faces) > 0 else "NO FACE DETECTED - Move closer to camera"
    color = (0, 255, 0) if len(faces) > 0 else (0, 0, 255)
    cv2.putText(frame, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
    cv2.putText(frame, "Press Q to quit", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    
    # Show the frame
    cv2.imshow('Camera Test - Check Face Detection', frame)
    
    key = cv2.waitKey(1) & 0xFF
    if key == ord('q'):
        break
    elif key == ord('s'):
        cv2.imwrite('camera_snapshot.jpg', frame)
        print("Snapshot saved!")

cap.release()
cv2.destroyAllWindows()
print("Camera test ended.")

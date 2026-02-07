"""
Sharingan Eye Tracking Server - IMPROVED ACCURACY VERSION
Uses OpenCV Haar Cascades with advanced calibration for precise tracking
"""

import cv2
import numpy as np
import asyncio
import websockets
import json
import time
import base64
from collections import deque

# ============== CONFIGURATION ==============
CONFIG = {
    "WEBSOCKET_PORT": 8765,
    "CAMERA_ID": 0,
    "CAMERA_WIDTH": 640,
    "CAMERA_HEIGHT": 480,
    "CAMERA_FPS": 30,
    
    # Camera preview (set False to only show in browser)
    "SHOW_PREVIEW": False,
    
    # Screen dimensions (updated by client)
    "SCREEN_WIDTH": 1920,
    "SCREEN_HEIGHT": 1080,
    
    # Smoothing - Lower = smoother but laggier, Higher = responsive but jittery
    "SMOOTHING_BUFFER_SIZE": 5,  # Increased for more stability
    "EMA_ALPHA": 0.4,  # Lower = smoother tracking
    
    # Calibration
    "CALIBRATION_POINTS": 9,
    
    # Gaze sensitivity - ADJUST THESE FOR YOUR SETUP
    "SENSITIVITY_X": 2.0,  # Higher = more movement per eye movement
    "SENSITIVITY_Y": 2.5,  # Usually Y needs more sensitivity
    
    # Mirror the camera (so it acts like looking in a mirror)
    "MIRROR_CAMERA": True,
    
    # Head movement compensation
    "HEAD_COMPENSATION_X": 0.3,
    "HEAD_COMPENSATION_Y": 0.3,
}


class ImprovedGazeEstimator:
    def __init__(self):
        # Load cascades
        cv_path = cv2.data.haarcascades
        self.face_cascade = cv2.CascadeClassifier(cv_path + 'haarcascade_frontalface_default.xml')
        self.eye_cascade = cv2.CascadeClassifier(cv_path + 'haarcascade_eye.xml')
        
        # Smoothing
        self.gaze_history_x = deque(maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
        self.gaze_history_y = deque(maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
        self.ema_x = None
        self.ema_y = None
        
        # Tracking state
        self.last_face = None
        self.last_eyes = []
        self.baseline_iris = None
        self.baseline_head = None
        
        # Calibration - using homography for accurate mapping
        self.calibration_points_raw = []  # Raw iris positions during calibration
        self.calibration_points_screen = []  # Corresponding screen positions
        self.homography_matrix = None
        self.is_calibrated = False
        
        # Simple offset calibration as fallback
        self.offset_x = 0
        self.offset_y = 0
        self.scale_x = 1.0
        self.scale_y = 1.0
        
        # Current raw gaze for calibration
        self.current_raw_gaze = None
        
    def detect_pupil_center(self, eye_roi):
        """Improved pupil detection using multiple methods"""
        if eye_roi.size == 0:
            return None
            
        gray = cv2.cvtColor(eye_roi, cv2.COLOR_BGR2GRAY) if len(eye_roi.shape) == 3 else eye_roi
        h, w = gray.shape
        
        # Method 1: Find darkest region (pupil is dark)
        blurred = cv2.GaussianBlur(gray, (7, 7), 0)
        
        # Apply histogram equalization for better contrast
        equalized = cv2.equalizeHist(blurred)
        
        # Threshold to find dark pupil
        _, thresh = cv2.threshold(equalized, 30, 255, cv2.THRESH_BINARY_INV)
        
        # Morphological operations to clean up
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        
        # Find contours
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if contours:
            # Find the most circular contour
            best_contour = None
            best_score = 0
            
            for contour in contours:
                area = cv2.contourArea(contour)
                if area < 20 or area > (w * h * 0.5):
                    continue
                    
                perimeter = cv2.arcLength(contour, True)
                if perimeter == 0:
                    continue
                    
                # Circularity score
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                
                if circularity > best_score:
                    best_score = circularity
                    best_contour = contour
            
            if best_contour is not None:
                M = cv2.moments(best_contour)
                if M["m00"] > 0:
                    cx = int(M["m10"] / M["m00"])
                    cy = int(M["m01"] / M["m00"])
                    return (cx, cy)
        
        # Method 2: Find minimum intensity point as fallback
        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(blurred)
        return min_loc
    
    def estimate_gaze(self, frame):
        """Estimate gaze position with improved accuracy"""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = frame.shape[:2]
        
        # Detect face
        faces = self.face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=4, minSize=(80, 80)
        )
        
        if len(faces) == 0:
            if self.last_face is not None:
                faces = [self.last_face]
            else:
                return None
        
        (fx, fy, fw, fh) = faces[0]
        self.last_face = faces[0]
        
        # Calculate head position relative to center
        head_x = (fx + fw/2 - w/2) / (w/2)  # -1 to 1
        head_y = (fy + fh/2 - h/2) / (h/2)
        
        if self.baseline_head is None:
            self.baseline_head = (head_x, head_y)
        
        # Head movement from baseline
        head_delta_x = head_x - self.baseline_head[0]
        head_delta_y = head_y - self.baseline_head[1]
        
        # Extract upper face for eyes
        eye_region = gray[fy:fy + int(fh * 0.6), fx:fx + fw]
        eye_region_color = frame[fy:fy + int(fh * 0.6), fx:fx + fw]
        
        if eye_region.size == 0:
            return None
        
        # Detect eyes
        eyes = self.eye_cascade.detectMultiScale(
            eye_region, scaleFactor=1.1, minNeighbors=3, minSize=(25, 25)
        )
        
        if len(eyes) < 1:
            if len(self.last_eyes) > 0:
                eyes = self.last_eyes
            else:
                return None
        
        # Sort and take up to 2 eyes
        eyes = sorted(eyes, key=lambda e: e[0])[:2]
        self.last_eyes = list(eyes)
        
        # Get pupil positions
        iris_positions = []
        
        for (ex, ey, ew, eh) in eyes:
            eye_roi = eye_region_color[ey:ey+eh, ex:ex+ew]
            if eye_roi.size == 0:
                continue
            
            pupil = self.detect_pupil_center(eye_roi)
            if pupil:
                # Normalize pupil position within eye region (-1 to 1)
                norm_x = (pupil[0] - ew/2) / (ew/2)
                norm_y = (pupil[1] - eh/2) / (eh/2)
                iris_positions.append((norm_x, norm_y))
        
        if len(iris_positions) == 0:
            return None
        
        # Average iris position
        avg_iris_x = np.mean([p[0] for p in iris_positions])
        avg_iris_y = np.mean([p[1] for p in iris_positions])
        
        # Set baseline on first detection
        if self.baseline_iris is None:
            self.baseline_iris = (avg_iris_x, avg_iris_y)
        
        # Calculate relative iris movement from baseline
        iris_delta_x = avg_iris_x - self.baseline_iris[0]
        iris_delta_y = avg_iris_y - self.baseline_iris[1]
        
        # Combine iris tracking with head compensation
        # Screen center
        screen_cx = CONFIG["SCREEN_WIDTH"] / 2
        screen_cy = CONFIG["SCREEN_HEIGHT"] / 2
        
        # Map iris movement to screen coordinates
        # When looking right, iris moves right in mirrored view, which should map to right on screen
        raw_x = screen_cx + (iris_delta_x * CONFIG["SENSITIVITY_X"] * CONFIG["SCREEN_WIDTH"] / 4)
        raw_y = screen_cy + (iris_delta_y * CONFIG["SENSITIVITY_Y"] * CONFIG["SCREEN_HEIGHT"] / 4)
        
        # Add head compensation
        raw_x -= head_delta_x * CONFIG["HEAD_COMPENSATION_X"] * CONFIG["SCREEN_WIDTH"]
        raw_y += head_delta_y * CONFIG["HEAD_COMPENSATION_Y"] * CONFIG["SCREEN_HEIGHT"]
        
        # Store raw gaze for calibration
        self.current_raw_gaze = (raw_x, raw_y)
        
        # Apply calibration if available
        if self.is_calibrated and self.homography_matrix is not None:
            # Use homography for accurate mapping
            point = np.array([[[raw_x, raw_y]]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point, self.homography_matrix)
            calibrated_x = transformed[0][0][0]
            calibrated_y = transformed[0][0][1]
        elif self.is_calibrated:
            # Simple offset/scale calibration
            calibrated_x = (raw_x - self.offset_x) * self.scale_x
            calibrated_y = (raw_y - self.offset_y) * self.scale_y
        else:
            calibrated_x = raw_x
            calibrated_y = raw_y
        
        # Clamp to screen
        calibrated_x = max(0, min(CONFIG["SCREEN_WIDTH"], calibrated_x))
        calibrated_y = max(0, min(CONFIG["SCREEN_HEIGHT"], calibrated_y))
        
        # Apply smoothing
        smoothed_x, smoothed_y = self.smooth_gaze(calibrated_x, calibrated_y)
        
        confidence = min(1.0, 0.5 + len(iris_positions) * 0.25)
        
        return (smoothed_x, smoothed_y, confidence)
    
    def smooth_gaze(self, x, y):
        """Smooth gaze with weighted average + EMA"""
        self.gaze_history_x.append(x)
        self.gaze_history_y.append(y)
        
        # Weighted average (recent = higher weight)
        if len(self.gaze_history_x) > 0:
            weights = np.arange(1, len(self.gaze_history_x) + 1, dtype=float)
            weights = weights / weights.sum()
            avg_x = np.average(list(self.gaze_history_x), weights=weights)
            avg_y = np.average(list(self.gaze_history_y), weights=weights)
        else:
            avg_x, avg_y = x, y
        
        # EMA
        if self.ema_x is None:
            self.ema_x = avg_x
            self.ema_y = avg_y
        else:
            alpha = CONFIG["EMA_ALPHA"]
            self.ema_x = alpha * avg_x + (1 - alpha) * self.ema_x
            self.ema_y = alpha * avg_y + (1 - alpha) * self.ema_y
        
        return self.ema_x, self.ema_y
    
    def add_calibration_point(self, screen_x, screen_y):
        """Add a calibration point"""
        if self.current_raw_gaze is None:
            print("No raw gaze available for calibration")
            return False
        
        raw_x, raw_y = self.current_raw_gaze
        
        self.calibration_points_raw.append([raw_x, raw_y])
        self.calibration_points_screen.append([screen_x, screen_y])
        
        print(f"Calibration point {len(self.calibration_points_screen)}: screen=({screen_x}, {screen_y}), raw=({raw_x:.0f}, {raw_y:.0f})")
        
        if len(self.calibration_points_screen) >= CONFIG["CALIBRATION_POINTS"]:
            self.compute_calibration()
        
        return True
    
    def compute_calibration(self):
        """Compute calibration transformation"""
        if len(self.calibration_points_screen) < 4:
            print("Need at least 4 points for calibration")
            return
        
        raw_pts = np.array(self.calibration_points_raw, dtype=np.float32)
        screen_pts = np.array(self.calibration_points_screen, dtype=np.float32)
        
        try:
            # Try homography for accurate mapping
            self.homography_matrix, _ = cv2.findHomography(raw_pts, screen_pts, cv2.RANSAC, 5.0)
            
            if self.homography_matrix is not None:
                self.is_calibrated = True
                print("✅ Calibration complete using homography!")
                return
        except Exception as e:
            print(f"Homography failed: {e}")
        
        # Fallback: simple offset and scale
        raw_center = np.mean(raw_pts, axis=0)
        screen_center = np.mean(screen_pts, axis=0)
        
        self.offset_x = raw_center[0] - screen_center[0]
        self.offset_y = raw_center[1] - screen_center[1]
        
        raw_range_x = np.ptp(raw_pts[:, 0])
        raw_range_y = np.ptp(raw_pts[:, 1])
        screen_range_x = np.ptp(screen_pts[:, 0])
        screen_range_y = np.ptp(screen_pts[:, 1])
        
        if raw_range_x > 0:
            self.scale_x = screen_range_x / raw_range_x
        if raw_range_y > 0:
            self.scale_y = screen_range_y / raw_range_y
        
        self.is_calibrated = True
        print(f"✅ Calibration complete (offset/scale): offset=({self.offset_x:.0f}, {self.offset_y:.0f}), scale=({self.scale_x:.2f}, {self.scale_y:.2f})")
    
    def reset_calibration(self):
        """Reset all calibration data"""
        self.calibration_points_raw = []
        self.calibration_points_screen = []
        self.homography_matrix = None
        self.is_calibrated = False
        self.offset_x = 0
        self.offset_y = 0
        self.scale_x = 1.0
        self.scale_y = 1.0
        self.baseline_iris = None
        self.baseline_head = None
        print("Calibration reset")


class GazeServer:
    def __init__(self):
        self.gaze_estimator = ImprovedGazeEstimator()
        self.cap = None
        self.clients = set()
        self.running = False
        
    def start_camera(self):
        self.cap = cv2.VideoCapture(CONFIG["CAMERA_ID"])
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CONFIG["CAMERA_WIDTH"])
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CONFIG["CAMERA_HEIGHT"])
        self.cap.set(cv2.CAP_PROP_FPS, CONFIG["CAMERA_FPS"])
        
        if not self.cap.isOpened():
            raise RuntimeError("Could not open camera")
        
        print(f"Camera started: {CONFIG['CAMERA_WIDTH']}x{CONFIG['CAMERA_HEIGHT']} @ {CONFIG['CAMERA_FPS']}fps")
    
    def stop_camera(self):
        if self.cap:
            self.cap.release()
            self.cap = None
    
    async def handle_client(self, websocket):
        print(f"Client connected")
        self.clients.add(websocket)
        
        try:
            async for message in websocket:
                data = json.loads(message)
                await self.handle_message(websocket, data)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.remove(websocket)
            print(f"Client disconnected")
    
    async def handle_message(self, websocket, data):
        msg_type = data.get("type")
        
        if msg_type == "screen_size":
            CONFIG["SCREEN_WIDTH"] = data.get("width", 1920)
            CONFIG["SCREEN_HEIGHT"] = data.get("height", 1080)
            print(f"Screen size: {CONFIG['SCREEN_WIDTH']}x{CONFIG['SCREEN_HEIGHT']}")
            
        elif msg_type == "calibration_point":
            screen_x = data.get("screen_x")
            screen_y = data.get("screen_y")
            
            success = self.gaze_estimator.add_calibration_point(screen_x, screen_y)
            
            await websocket.send(json.dumps({
                "type": "calibration_ack",
                "points_collected": len(self.gaze_estimator.calibration_points_screen),
                "is_calibrated": self.gaze_estimator.is_calibrated,
                "success": success
            }))
                    
        elif msg_type == "reset_calibration":
            self.gaze_estimator.reset_calibration()
            await websocket.send(json.dumps({"type": "calibration_reset"}))
            
        elif msg_type == "start_tracking":
            self.running = True
            await self.tracking_loop(websocket)
            
        elif msg_type == "stop_tracking":
            self.running = False
            
        elif msg_type == "adjust_sensitivity":
            CONFIG["SENSITIVITY_X"] = data.get("x", CONFIG["SENSITIVITY_X"])
            CONFIG["SENSITIVITY_Y"] = data.get("y", CONFIG["SENSITIVITY_Y"])
            print(f"Sensitivity adjusted: X={CONFIG['SENSITIVITY_X']}, Y={CONFIG['SENSITIVITY_Y']}")
    
    async def tracking_loop(self, websocket):
        frame_time = 1.0 / CONFIG["CAMERA_FPS"]
        frame_count = 0
        
        print("Starting tracking loop...")
        
        while self.running:
            start_time = time.time()
            
            ret, frame = self.cap.read()
            if not ret:
                continue
            
            # Mirror the camera frame horizontally (like looking in a mirror)
            if CONFIG.get("MIRROR_CAMERA", True):
                frame = cv2.flip(frame, 1)
            
            frame_count += 1
            
            # Create display frame
            display_frame = frame.copy()
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            h, w = frame.shape[:2]
            
            # Detect and draw faces/eyes for preview
            faces = self.gaze_estimator.face_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4, minSize=(80, 80)
            )
            
            result = self.gaze_estimator.estimate_gaze(frame)
            
            # Draw detection on preview
            if len(faces) > 0:
                (fx, fy, fw, fh) = faces[0]
                cv2.rectangle(display_frame, (fx, fy), (fx+fw, fy+fh), (0, 255, 0), 2)
                
                # Draw eyes
                eye_region = gray[fy:fy + int(fh * 0.6), fx:fx + fw]
                eyes = self.gaze_estimator.eye_cascade.detectMultiScale(
                    eye_region, scaleFactor=1.1, minNeighbors=3, minSize=(25, 25)
                )
                for (ex, ey, ew, eh) in eyes[:2]:
                    cv2.rectangle(display_frame, (fx+ex, fy+ey), (fx+ex+ew, fy+ey+eh), (255, 0, 0), 2)
                    # Draw pupil center
                    cv2.circle(display_frame, (fx+ex+ew//2, fy+ey+eh//2), 3, (0, 255, 255), -1)
            
            if result:
                gaze_x, gaze_y, confidence = result
                
                status = f"Gaze: ({gaze_x:.0f}, {gaze_y:.0f})"
                cv2.putText(display_frame, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                
                if frame_count % 30 == 0:
                    print(f"Gaze: ({gaze_x:.0f}, {gaze_y:.0f}) conf={confidence:.2f}")
                
                try:
                    await websocket.send(json.dumps({
                        "type": "gaze",
                        "x": round(gaze_x, 1),
                        "y": round(gaze_y, 1),
                        "confidence": round(confidence, 2),
                        "timestamp": time.time() * 1000
                    }))
                except websockets.exceptions.ConnectionClosed:
                    break
            else:
                cv2.putText(display_frame, "NO DETECTION", (10, 30), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            
            # Send frame to browser (every 3rd frame)
            if frame_count % 3 == 0:
                try:
                    small = cv2.resize(display_frame, (320, 240))
                    _, buffer = cv2.imencode('.jpg', small, [cv2.IMWRITE_JPEG_QUALITY, 60])
                    frame_b64 = base64.b64encode(buffer).decode('utf-8')
                    await websocket.send(json.dumps({
                        "type": "frame",
                        "data": frame_b64
                    }))
                except:
                    pass
            
            # Optional: Show preview window
            if CONFIG["SHOW_PREVIEW"]:
                cv2.imshow("Sharingan", display_frame)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break
            
            elapsed = time.time() - start_time
            await asyncio.sleep(max(0, frame_time - elapsed))
        
        if CONFIG["SHOW_PREVIEW"]:
            cv2.destroyAllWindows()
    
    async def run(self):
        self.start_camera()
        
        print(f"\n{'='*50}")
        print(f"  SHARINGAN GAZE SERVER - IMPROVED ACCURACY")
        print(f"  WebSocket: ws://localhost:{CONFIG['WEBSOCKET_PORT']}")
        print(f"  Sensitivity: X={CONFIG['SENSITIVITY_X']}, Y={CONFIG['SENSITIVITY_Y']}")
        print(f"{'='*50}\n")
        
        async with websockets.serve(self.handle_client, "localhost", CONFIG["WEBSOCKET_PORT"]):
            await asyncio.Future()


def main():
    print("\n🔴 Starting Sharingan Gaze Server (Improved Accuracy)...")
    print("Press Ctrl+C to stop\n")
    
    server = GazeServer()
    
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\n\nShutting down...")
    finally:
        server.stop_camera()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

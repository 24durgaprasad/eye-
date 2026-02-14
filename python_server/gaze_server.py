"""
Sharingan Eye Tracking Server - IMPROVED ACCURACY VERSION
Uses MediaPipe Face Landmarker with iris landmarks for robust eye tracking
"""

import cv2
import numpy as np
import asyncio
import websockets
import json
import time
import base64
from collections import deque
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

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
    
    # Smoothing - Optimized for responsive tracking (less stuck)
    "SMOOTHING_BUFFER_SIZE": 5,  # Smaller buffer for faster response
    "EMA_ALPHA": 0.5,  # Higher = more responsive (was 0.25, too slow)
    
    # Calibration
    "CALIBRATION_POINTS": 9,
    
    # Gaze sensitivity - higher = you can reach screen edges with smaller eye movement
    "SENSITIVITY_X": 6.5,  # Significantly increased to reach right edge easily
    "SENSITIVITY_Y": 5.5,  # Significantly increased to reach top edge (was 3.0, too low)
    
    # Mirror the camera (so it acts like looking in a mirror)
    "MIRROR_CAMERA": True,
    
    # Head movement compensation - reduced to minimum so it doesn't cancel eye movement
    "HEAD_COMPENSATION_X": 0.03,  # Much reduced - head movement shouldn't cancel eye tracking
    "HEAD_COMPENSATION_Y": 0.05,  # Much reduced for vertical - was 0.15, too high
    
    # Outlier rejection threshold (ignore sudden jumps)
    "OUTLIER_THRESHOLD": 400,  # pixels - increased to allow larger movements (was 200, too restrictive)
}


class ImprovedGazeEstimator:
    def __init__(self):
        # MediaPipe Tasks Face Landmarker with iris landmarks for robust eye tracking
        base_options = mp_python.BaseOptions(model_asset_path="face_landmarker.task")
        options = mp_vision.FaceLandmarkerOptions(
            base_options=base_options,
            num_faces=1,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )
        self.face_landmarker = mp_vision.FaceLandmarker.create_from_options(options)

        # Smoothing
        self.gaze_history_x = deque(maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
        self.gaze_history_y = deque(maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
        self.ema_x = None
        self.ema_y = None

        # Tracking state
        self.baseline_iris = None
        self.baseline_head = None

        # Stuck detection - reset baseline if cursor stuck
        self.last_gaze_positions = deque(maxlen=30)  # Track last 30 positions
        self.last_raw_gaze = deque(maxlen=10)  # Track raw gaze to detect if user is trying to move
        self.stuck_threshold = 10  # Increased threshold - only reset if stuck for 10 frames

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

        # For debug drawing
        self.last_landmarks = None
        
        # Blink detection
        self.eye_closed_frames = 0  # Count consecutive frames with eyes closed
        self.blink_threshold = 3  # Eyes must be closed for 3 frames to register blink
        self.last_blink_time = 0  # Prevent multiple triggers
        self.blink_cooldown = 0.5  # Minimum time between blinks (seconds)
        
        # Eye landmark indices for EAR calculation (MediaPipe Face Landmarker)
        # Face Landmarker has 468 landmarks, using key points for eye aspect ratio
        # Left eye key points: outer corner, inner corner, top center, bottom center
        # Right eye key points: outer corner, inner corner, top center, bottom center
        # Using simplified 4-point method for robustness
        self.left_eye_indices = [33, 133, 159, 145]  # [outer corner, inner corner, top, bottom]
        self.right_eye_indices = [362, 263, 386, 374]  # [outer corner, inner corner, top, bottom]

    def calculate_eye_aspect_ratio(self, eye_landmarks):
        """Calculate Eye Aspect Ratio (EAR) - lower value means eye is more closed"""
        if len(eye_landmarks) < 4:
            return 1.0  # Default to open if not enough points
        
        # Get the 4 key points: outer, inner, top, bottom
        outer, inner, top, bottom = eye_landmarks[:4]
        
        # Calculate vertical distance (top to bottom)
        vertical = np.sqrt((top.x - bottom.x)**2 + (top.y - bottom.y)**2)
        
        # Calculate horizontal distance (outer to inner corner)
        horizontal = np.sqrt((outer.x - inner.x)**2 + (outer.y - inner.y)**2)
        
        if horizontal == 0:
            return 1.0
        
        # EAR = vertical distance / horizontal distance
        # When eye is open, vertical is larger relative to horizontal
        # When eye is closed, vertical becomes very small
        ear = vertical / horizontal
        return ear
    
    def detect_blink(self, face_landmarks):
        """Detect if user is blinking (both eyes closed)"""
        if len(face_landmarks) < max(max(self.left_eye_indices), max(self.right_eye_indices)) + 1:
            return False, 1.0
        
        # Get eye landmarks
        left_eye_points = [face_landmarks[i] for i in self.left_eye_indices if i < len(face_landmarks)]
        right_eye_points = [face_landmarks[i] for i in self.right_eye_indices if i < len(face_landmarks)]
        
        if len(left_eye_points) < 4 or len(right_eye_points) < 4:
            return False, 1.0
        
        # Calculate EAR for both eyes
        left_ear = self.calculate_eye_aspect_ratio(left_eye_points)
        right_ear = self.calculate_eye_aspect_ratio(right_eye_points)
        
        # Average EAR
        avg_ear = (left_ear + right_ear) / 2.0
        
        # Eye is closed if EAR < 0.15 (threshold tuned for MediaPipe Face Landmarker)
        # Lower threshold because our simplified EAR calculation gives different values
        eyes_closed = avg_ear < 0.15
        
        return eyes_closed, avg_ear

    def estimate_gaze(self, frame):
        """Estimate gaze position using MediaPipe Face Landmarker with iris landmarks"""
        if frame is None or frame.size == 0:
            return None

        h, w = frame.shape[:2]

        # MediaPipe expects RGB
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        results = self.face_landmarker.detect(mp_image)

        if not results.face_landmarks:
            return None

        # Use first detected face (list of NormalizedLandmark)
        face_landmarks = results.face_landmarks[0]
        self.last_landmarks = face_landmarks
        
        # Detect blink
        eyes_closed, ear_value = self.detect_blink(face_landmarks)
        
        # Track blink state
        if eyes_closed:
            self.eye_closed_frames += 1
        else:
            self.eye_closed_frames = 0
        
        # Check if blink is detected (eyes closed for threshold frames)
        blink_detected = False
        current_time = time.time()
        if self.eye_closed_frames >= self.blink_threshold:
            # Check cooldown to prevent multiple triggers
            if current_time - self.last_blink_time > self.blink_cooldown:
                blink_detected = True
                self.last_blink_time = current_time
                self.eye_closed_frames = 0  # Reset counter

        # Convert landmarks to numpy for convenience
        xs = np.array([lm.x for lm in face_landmarks])
        ys = np.array([lm.y for lm in face_landmarks])

        # Head position relative to image center (-1 to 1)
        face_cx = xs.mean()
        face_cy = ys.mean()
        head_x = (face_cx - 0.5) * 2.0
        head_y = (face_cy - 0.5) * 2.0

        if self.baseline_head is None:
            self.baseline_head = (head_x, head_y)
        else:
            # Slowly update head baseline too
            alpha_baseline = 0.01
            self.baseline_head = (
                self.baseline_head[0] * (1 - alpha_baseline) + head_x * alpha_baseline,
                self.baseline_head[1] * (1 - alpha_baseline) + head_y * alpha_baseline
            )

        head_delta_x = head_x - self.baseline_head[0]
        head_delta_y = head_y - self.baseline_head[1]

        # Iris landmarks (left eye iris) indices for MediaPipe Face Mesh
        iris_indices = [468, 469, 470, 471, 472]
        iris_points = [face_landmarks[i] for i in iris_indices if i < len(face_landmarks)]

        if not iris_points:
            return None

        iris_x = float(np.mean([p.x for p in iris_points]))
        iris_y = float(np.mean([p.y for p in iris_points]))

        # Set baseline on first detection, or use rolling average for stability
        if self.baseline_iris is None:
            self.baseline_iris = (iris_x, iris_y)
        else:
            # Slowly update baseline (rolling average) to adapt to head position changes
            # This prevents getting stuck when head moves slightly
            alpha_baseline = 0.01  # Very slow update
            self.baseline_iris = (
                self.baseline_iris[0] * (1 - alpha_baseline) + iris_x * alpha_baseline,
                self.baseline_iris[1] * (1 - alpha_baseline) + iris_y * alpha_baseline
            )

        # Relative iris movement from baseline
        iris_delta_x = iris_x - self.baseline_iris[0]
        iris_delta_y = iris_y - self.baseline_iris[1]

        # Screen center
        screen_cx = CONFIG["SCREEN_WIDTH"] / 2
        screen_cy = CONFIG["SCREEN_HEIGHT"] / 2

        # Map iris movement to screen coordinates with non-linear amplification near edges
        # Use larger multiplier and add edge amplification
        base_sensitivity_x = CONFIG["SENSITIVITY_X"] * CONFIG["SCREEN_WIDTH"] / 3  # Changed from /4 to /3 for more range
        base_sensitivity_y = CONFIG["SENSITIVITY_Y"] * CONFIG["SCREEN_HEIGHT"] / 3  # Changed from /4 to /3 for more vertical range
        
        # Non-linear amplification: if looking right (positive delta), amplify more
        if iris_delta_x > 0:
            # Amplify rightward movement more to reach right edge
            sensitivity_multiplier_x = 1.0 + (iris_delta_x * 0.5)  # Up to 1.5x amplification
        else:
            sensitivity_multiplier_x = 1.0
        
        # Non-linear amplification: if looking up (negative delta_y in normalized coords = looking up), amplify more
        if iris_delta_y < 0:  # Negative delta means looking up
            # Amplify upward movement more to reach top edge
            sensitivity_multiplier_y = 1.0 + (abs(iris_delta_y) * 0.6)  # Up to 1.6x amplification for upward
        else:
            sensitivity_multiplier_y = 1.0
        
        raw_x = screen_cx + (iris_delta_x * base_sensitivity_x * sensitivity_multiplier_x)
        raw_y = screen_cy + (iris_delta_y * base_sensitivity_y * sensitivity_multiplier_y)

        # Add head compensation (minimal to avoid canceling eye movement)
        # Only apply if head movement is significant, and reduce it
        head_comp_x = head_delta_x * CONFIG["HEAD_COMPENSATION_X"] * CONFIG["SCREEN_WIDTH"]
        head_comp_y = head_delta_y * CONFIG["HEAD_COMPENSATION_Y"] * CONFIG["SCREEN_HEIGHT"]
        
        # Reduce head compensation when looking at edges (where we need full eye movement)
        edge_factor_x = 1.0
        edge_factor_y = 1.0
        if abs(iris_delta_x) > 0.1:  # If looking significantly left/right
            edge_factor_x = 0.5  # Reduce horizontal head compensation by half
        if abs(iris_delta_y) > 0.1:  # If looking significantly up/down
            edge_factor_y = 0.3  # Reduce vertical head compensation even more (to 30%)
        
        raw_x -= head_comp_x * edge_factor_x
        raw_y += head_comp_y * edge_factor_y

        # Store raw gaze for calibration
        self.current_raw_gaze = (raw_x, raw_y)
        self.last_raw_gaze.append((raw_x, raw_y))  # Track raw gaze for stuck detection

        # Apply calibration if available
        if self.is_calibrated and self.homography_matrix is not None:
            point = np.array([[[raw_x, raw_y]]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point, self.homography_matrix)
            calibrated_x = float(transformed[0][0][0])
            calibrated_y = float(transformed[0][0][1])
        elif self.is_calibrated:
            calibrated_x = (raw_x - self.offset_x) * self.scale_x
            calibrated_y = (raw_y - self.offset_y) * self.scale_y
        else:
            calibrated_x = raw_x
            calibrated_y = raw_y

        # Clamp to screen
        calibrated_x = max(0, min(CONFIG["SCREEN_WIDTH"], calibrated_x))
        calibrated_y = max(0, min(CONFIG["SCREEN_HEIGHT"], calibrated_y))

        # Apply smoothing with outlier rejection
        smoothed_x, smoothed_y = self.smooth_gaze(calibrated_x, calibrated_y)

        # Detect if cursor is stuck (smarter detection - only if user is trying to move but cursor isn't)
        self.last_gaze_positions.append((smoothed_x, smoothed_y))
        if len(self.last_gaze_positions) >= self.stuck_threshold and len(self.last_raw_gaze) >= 5:
            # Check if smoothed cursor position is stuck (within 15 pixels for many frames)
            recent_positions = list(self.last_gaze_positions)[-self.stuck_threshold:]
            first_pos = recent_positions[0]
            all_similar = all(
                abs(p[0] - first_pos[0]) < 15 and abs(p[1] - first_pos[1]) < 15
                for p in recent_positions
            )
            
            # Check if raw gaze is changing (user is trying to move)
            recent_raw = list(self.last_raw_gaze)[-5:]
            raw_is_changing = False
            if len(recent_raw) >= 5:
                raw_range_x = max(p[0] for p in recent_raw) - min(p[0] for p in recent_raw)
                raw_range_y = max(p[1] for p in recent_raw) - min(p[1] for p in recent_raw)
                # If raw gaze is moving significantly but cursor isn't, we're stuck
                raw_is_changing = raw_range_x > 50 or raw_range_y > 50
            
            # Only reset if: cursor is stuck AND user is trying to move (raw gaze changing)
            # Don't reset if user is intentionally holding still
            if all_similar and raw_is_changing:
                # Gently nudge baseline instead of full reset to avoid disrupting tracking
                print(f"⚠️ Cursor stuck at ({smoothed_x:.0f}, {smoothed_y:.0f}), adjusting baseline...")
                # Move baseline slightly toward current iris position (partial reset)
                self.baseline_iris = (
                    self.baseline_iris[0] * 0.7 + iris_x * 0.3,
                    self.baseline_iris[1] * 0.7 + iris_y * 0.3
                )
                self.baseline_head = (
                    self.baseline_head[0] * 0.7 + head_x * 0.3,
                    self.baseline_head[1] * 0.7 + head_y * 0.3
                )
                # Clear some smoothing history but not all
                if len(self.gaze_history_x) > 3:
                    self.gaze_history_x = deque(list(self.gaze_history_x)[-2:], maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
                    self.gaze_history_y = deque(list(self.gaze_history_y)[-2:], maxlen=CONFIG["SMOOTHING_BUFFER_SIZE"])
                self.last_gaze_positions.clear()
                self.last_raw_gaze.clear()

        # Confidence: full face + iris landmarks -> high confidence
        confidence = 0.9

        return smoothed_x, smoothed_y, confidence, blink_detected

    def smooth_gaze(self, x, y):
        """Smooth gaze with weighted average + EMA + outlier rejection"""
        # Outlier rejection - ignore sudden jumps
        if self.ema_x is not None and self.ema_y is not None:
            distance = np.sqrt((x - self.ema_x) ** 2 + (y - self.ema_y) ** 2)
            if distance > CONFIG.get("OUTLIER_THRESHOLD", 200):
                # Return previous smoothed value, don't update
                return self.ema_x, self.ema_y

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

        print(
            f"Calibration point {len(self.calibration_points_screen)}: "
            f"screen=({screen_x}, {screen_y}), raw=({raw_x:.0f}, {raw_y:.0f})"
        )

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
            self.homography_matrix, _ = cv2.findHomography(
                raw_pts, screen_pts, cv2.RANSAC, 5.0
            )

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
        print(
            f"✅ Calibration complete (offset/scale): "
            f"offset=({self.offset_x:.0f}, {self.offset_y:.0f}), "
            f"scale=({self.scale_x:.2f}, {self.scale_y:.2f})"
        )

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
        # Reset stuck detection
        self.last_gaze_positions.clear()
        self.gaze_history_x.clear()
        self.gaze_history_y.clear()
        self.ema_x = None
        self.ema_y = None
        print("Calibration reset")

    def draw_debug(self, frame):
        """Draw simple debug overlay (face box + iris) on the preview frame."""
        if self.last_landmarks is None or frame is None or frame.size == 0:
            return

        h, w = frame.shape[:2]
        xs = np.array([lm.x for lm in self.last_landmarks])
        ys = np.array([lm.y for lm in self.last_landmarks])

        # Face bounding box
        x_min = int(xs.min() * w)
        x_max = int(xs.max() * w)
        y_min = int(ys.min() * h)
        y_max = int(ys.max() * h)

        cv2.rectangle(frame, (x_min, y_min), (x_max, y_max), (0, 255, 0), 2)

        # Iris center (left eye)
        iris_indices = [468, 469, 470, 471, 472]
        iris_points = [
            self.last_landmarks[i]
            for i in iris_indices
            if i < len(self.last_landmarks)
        ]
        if iris_points:
            iris_x = int(np.mean([p.x for p in iris_points]) * w)
            iris_y = int(np.mean([p.y for p in iris_points]) * h)
            cv2.circle(frame, (iris_x, iris_y), 4, (255, 0, 0), -1)


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
            try:
                start_time = time.time()
                
                ret, frame = self.cap.read()
                if not ret:
                    await asyncio.sleep(0.01)  # Small delay if frame read fails
                    continue
                
                # Mirror the camera frame horizontally (like looking in a mirror)
                if CONFIG.get("MIRROR_CAMERA", True):
                    frame = cv2.flip(frame, 1)
                
                frame_count += 1
                
                # Create display frame
                display_frame = frame.copy()
                
                # Wrap estimate_gaze in try-except to prevent crashes
                try:
                    result = self.gaze_estimator.estimate_gaze(frame)
                except Exception as e:
                    print(f"Error in estimate_gaze: {e}")
                    result = None
                
                # Draw MediaPipe-based debug overlays (face box + iris)
                try:
                    self.gaze_estimator.draw_debug(display_frame)
                except Exception:
                    pass  # Ignore drawing errors
                
                if result:
                    gaze_x, gaze_y, confidence, blink_detected = result
                    
                    status = f"Gaze: ({gaze_x:.0f}, {gaze_y:.0f})"
                    if blink_detected:
                        status += " [BLINK]"
                        cv2.putText(display_frame, "BLINK DETECTED!", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
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
                        
                        # Send blink event if detected
                        if blink_detected:
                            print(f"👁️ Blink detected! Triggering double-click at ({gaze_x:.0f}, {gaze_y:.0f})")
                            await websocket.send(json.dumps({
                                "type": "blink",
                                "x": round(gaze_x, 1),
                                "y": round(gaze_y, 1),
                                "timestamp": time.time() * 1000
                            }))
                    except websockets.exceptions.ConnectionClosed:
                        break
                    except Exception as e:
                        print(f"Error sending gaze data: {e}")
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
                    except websockets.exceptions.ConnectionClosed:
                        break
                    except Exception:
                        pass  # Ignore frame send errors
                
                # Optional: Show preview window
                if CONFIG["SHOW_PREVIEW"]:
                    cv2.imshow("Sharingan", display_frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break
                
                elapsed = time.time() - start_time
                await asyncio.sleep(max(0, frame_time - elapsed))
                
            except websockets.exceptions.ConnectionClosed:
                print("Connection closed by client")
                break
            except Exception as e:
                print(f"Error in tracking loop: {e}")
                import traceback
                traceback.print_exc()
                # Don't break, continue loop to prevent reconnection spam
                await asyncio.sleep(0.1)
        
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

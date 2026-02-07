# 🐍 Sharingan Python + Browser Extension Hybrid

A high-accuracy eye tracking system using **MediaPipe** for gaze estimation and a Chrome extension for browser control.

## 🏗️ Architecture

```
┌─────────────────────────┐         WebSocket          ┌─────────────────────────┐
│   Browser Extension     │ ◄─────────────────────────►│    Python Server        │
│   (content_python.js)   │        localhost:8765      │    (gaze_server.py)     │
│                         │                             │                         │
│ • Sidebar UI            │         Gaze Data           │ • MediaPipe Face Mesh   │
│ • Zone detection        │ ◄─────────────────────────  │ • Iris tracking         │
│ • Browser control       │                             │ • Head pose compensation│
│ • Ask AI feature        │         Calibration         │ • Smoothing algorithms  │
│                         │ ─────────────────────────►  │ • OpenCV webcam capture │
└─────────────────────────┘                             └─────────────────────────┘
```

## 📋 Requirements

- **Python 3.8+** 
- **Webcam**
- **Chrome/Edge browser**

## 🚀 Quick Start

### Step 1: Install Python Dependencies

```bash
cd python_server
pip install -r requirements.txt
```

### Step 2: Start the Python Server

**Option A: Double-click** `start_server.bat`

**Option B: Command line**
```bash
cd python_server
python gaze_server.py
```

You should see:
```
==================================================
  SHARINGAN GAZE SERVER
  WebSocket: ws://localhost:8765
==================================================
```

### Step 3: Switch Extension to Python Mode

1. Rename `content.js` to `content_webgazer.js` (backup)
2. Rename `content_python.js` to `content.js`
3. Reload the extension in Chrome (`chrome://extensions` → Reload)

### Step 4: Use the Extension

1. Open any webpage
2. You'll see the sidebar on the right
3. Complete the calibration (click each dot 2 times while looking at it)
4. Control the browser with your eyes!

## 🎯 Why Python + MediaPipe?

| Feature | WebGazer.js | Python + MediaPipe |
|---------|-------------|-------------------|
| **Accuracy** | ~100-150px error | ~30-50px error |
| **Frame Rate** | ~15-20 fps | ~30 fps |
| **Iris Tracking** | Eye corners only | Full iris landmarks |
| **Head Compensation** | Basic | Advanced 3D pose |
| **Lighting Tolerance** | Poor | Good |

## ⚙️ Configuration

### Python Server (`gaze_server.py`)

```python
CONFIG = {
    "WEBSOCKET_PORT": 8765,        # Change if port conflict
    "CAMERA_ID": 0,                 # Change for different webcam
    "CAMERA_FPS": 30,               # Lower if CPU struggling
    "SMOOTHING_BUFFER_SIZE": 5,     # Higher = smoother but slower
    "EMA_ALPHA": 0.4,               # Higher = faster response
}
```

### Browser Extension (`content_python.js`)

```javascript
CONFIG = {
    PYTHON_SERVER_URL: 'ws://localhost:8765',
    DWELL_TIME: 600,                // ms to trigger action
    ZONE_SWITCH_DELAY: 100,         // ms hysteresis
}
```

## 🔧 Troubleshooting

### "Connection Error" in browser
- Make sure Python server is running
- Check if port 8765 is blocked by firewall
- Try restarting the server

### Webcam not detected
- Check `CONFIG["CAMERA_ID"]` in `gaze_server.py`
- Try 0, 1, or 2 for different cameras
- Ensure no other app is using the camera

### Laggy cursor
- Lower `CAMERA_FPS` to reduce CPU load
- Reduce `SMOOTHING_BUFFER_SIZE`
- Close other browser tabs

### Inaccurate tracking
- Recalibrate (click 🔄 button)
- Ensure good lighting on your face
- Sit at arm's length from screen
- Keep head relatively still

## 📁 File Structure

```
sharingan/
├── manifest.json           # Extension manifest
├── content.js              # Active extension code (swap between modes)
├── content_python.js       # Python-connected version
├── content_webgazer.js     # Original WebGazer version (backup)
├── webgazer.js             # WebGazer library (not used in Python mode)
├── popup.html/js           # Extension popup
│
└── python_server/
    ├── gaze_server.py      # Main Python server
    ├── requirements.txt    # Python dependencies
    └── start_server.bat    # Windows launcher
```

## 🎮 Controls

| Zone | Action |
|------|--------|
| **Scroll Up** | Scroll page up |
| **Scroll Down** | Scroll page down |
| **Media** | Play/Pause video |
| **Ask AI** | Open AI chat (Perplexity) |
| **Stop** | Pause tracking for 3 seconds |

---

**Made with 👁️ and 🐍**

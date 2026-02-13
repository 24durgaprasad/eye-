(function () {
    // ============== CONFIGURATION ==============
    const CONFIG = {
        // WebSocket connection to Python server
        PYTHON_SERVER_URL: 'ws://localhost:8765',
        RECONNECT_INTERVAL: 3000,

        // UI Settings
        SIDEBAR_WIDTH: 140,
        ZONE_COUNT: 5,
        DWELL_TIME: 600,
        SCROLL_SPEED: 8,
        SCROLL_INTERVAL: 16,

        // Zone hysteresis
        ZONE_SWITCH_DELAY: 100,

        // Calibration
        CALIBRATION_POINTS: 9,
        CLICKS_PER_POINT: 2,

        // Cursor smoothing (0.1 = very smooth, 0.5 = responsive, 1.0 = instant)
        CURSOR_SMOOTHING: 0.15,

        ZONES: ['SCROLL_UP', 'SCROLL_DOWN', 'MEDIA', 'ASK_AI', 'KILL_SWITCH'],
        STORAGE_KEY: 'sharingan_python_calibrated',
        PERPLEXITY_API_KEY: 'YOUR_API_KEY_HERE'
    };

    // ============== STATE ==============
    let state = {
        isActive: true,
        isScrolling: false,
        scrollDirection: null,
        scrollIntervalId: null,
        currentZone: null,
        pendingZone: null,
        zoneSwitchTime: null,
        dwellStartTime: null,

        // WebSocket
        ws: null,
        isConnected: false,
        reconnectTimer: null,

        // Gaze - target position (from server)
        gazeX: null,
        gazeY: null,

        // Gaze - current animated position (what we display)
        displayX: null,
        displayY: null,

        // Animation
        animationFrameId: null,
        lastAnimationTime: 0,

        // Calibration
        isCalibrated: false,
        calibrationClicks: 0
    };

    // ============== WEBSOCKET CONNECTION ==============
    function connectToServer() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            return;
        }

        console.log('[Sharingan] Connecting to Python server...');

        try {
            state.ws = new WebSocket(CONFIG.PYTHON_SERVER_URL);

            state.ws.onopen = () => {
                console.log('[Sharingan] Connected to Python server!');
                state.isConnected = true;
                updateStatusIndicator(true);
                showNotification('Connected', '✅ Python gaze server connected');

                // Send screen size
                state.ws.send(JSON.stringify({
                    type: 'screen_size',
                    width: window.innerWidth,
                    height: window.innerHeight
                }));

                // Start tracking
                state.ws.send(JSON.stringify({ type: 'start_tracking' }));
            };

            state.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleServerMessage(data);
            };

            state.ws.onclose = () => {
                console.log('[Sharingan] Disconnected from Python server');
                state.isConnected = false;
                updateStatusIndicator(false);

                // Try to reconnect
                if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
                state.reconnectTimer = setTimeout(connectToServer, CONFIG.RECONNECT_INTERVAL);
            };

            state.ws.onerror = (error) => {
                console.error('[Sharingan] WebSocket error:', error);
                showNotification('Connection Error', '❌ Start the Python server first!');
            };

        } catch (err) {
            console.error('[Sharingan] Failed to connect:', err);
            state.reconnectTimer = setTimeout(connectToServer, CONFIG.RECONNECT_INTERVAL);
        }
    }

    function handleServerMessage(data) {
        switch (data.type) {
            case 'gaze':
                if (state.isActive && state.isCalibrated) {
                    state.gazeX = data.x;
                    state.gazeY = data.y;
                    updateGazePosition(data.x, data.y);
                }
                break;

            case 'frame':
                // Update camera preview
                updateCameraPreview(data.data);
                break;

            case 'calibration_ack':
                console.log(`[Sharingan] Calibration points: ${data.points_collected}`);
                if (data.is_calibrated) {
                    finishCalibration();
                }
                break;

            case 'calibration_reset':
                state.isCalibrated = false;
                state.calibrationClicks = 0;
                break;
        }
    }

    function updateCameraPreview(base64Data) {
        let preview = document.getElementById('sharingan-camera-preview');
        if (preview) {
            preview.src = 'data:image/jpeg;base64,' + base64Data;
        }
    }

    function sendCalibrationPoint(screenX, screenY) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'calibration_point',
                screen_x: screenX,
                screen_y: screenY
            }));
        }
    }

    function resetCalibration() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'reset_calibration' }));
        }
        state.isCalibrated = false;
        state.calibrationClicks = 0;
        try {
            localStorage.removeItem(CONFIG.STORAGE_KEY);
        } catch (e) { }
    }

    // ============== CALIBRATION UI ==============
    function isCalibrationDone() {
        try {
            return localStorage.getItem(CONFIG.STORAGE_KEY) === 'true';
        } catch (e) {
            return false;
        }
    }

    function setCalibrationDone() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, 'true');
        } catch (e) { }
    }

    function createCalibrationOverlay() {
        if (isCalibrationDone()) {
            state.isCalibrated = true;
            showNotification('Sharingan', '✅ Calibration loaded from memory');
            return null;
        }

        const existingOverlay = document.getElementById('eye-calibration-overlay');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.id = 'eye-calibration-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: linear-gradient(135deg, rgba(10, 10, 30, 0.97) 0%, rgba(20, 20, 50, 0.98) 100%);
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            text-align: center;
            color: white;
            max-width: 600px;
            padding: 40px;
        `;

        content.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 20px;">🐍👁️</div>
            <h1 style="font-size: 32px; font-weight: 700; margin-bottom: 16px; background: linear-gradient(90deg, #ff6b6b, #feca57); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Sharingan + Python</h1>
            <p style="font-size: 18px; color: rgba(255,255,255,0.8); margin-bottom: 10px;">MediaPipe-powered eye tracking</p>
            <p style="font-size: 14px; color: rgba(255,255,255,0.6); margin-bottom: 30px;">Click each dot ${CONFIG.CLICKS_PER_POINT} times while looking at it</p>
            <div id="calibration-status" style="font-size: 24px; font-weight: 600; color: #feca57; margin-bottom: 10px;">Points: 0/${CONFIG.CALIBRATION_POINTS}</div>
            <div id="calibration-clicks" style="font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 20px;">Clicks on current dot: 0/${CONFIG.CLICKS_PER_POINT}</div>
            <div id="connection-status" style="font-size: 12px; color: ${state.isConnected ? '#00ffaa' : '#ff6b6b'}; margin-bottom: 20px;">
                ${state.isConnected ? '🟢 Python server connected' : '🔴 Waiting for Python server...'}
            </div>
            <button id="skip-calibration-btn" style="
                margin-top: 20px;
                padding: 10px 20px;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: 8px;
                color: rgba(255,255,255,0.7);
                cursor: pointer;
                font-size: 12px;
            ">Skip Calibration</button>
        `;

        overlay.appendChild(content);

        const positions = [
            { x: 10, y: 10 }, { x: 50, y: 10 }, { x: 90, y: 10 },
            { x: 10, y: 50 }, { x: 50, y: 50 }, { x: 90, y: 50 },
            { x: 10, y: 90 }, { x: 50, y: 90 }, { x: 90, y: 90 }
        ];

        const dotClicks = {};

        positions.forEach((pos, index) => {
            const dot = document.createElement('div');
            dot.className = 'calibration-dot';
            dot.dataset.index = index;
            dotClicks[index] = 0;

            dot.style.cssText = `
                position: absolute;
                left: ${pos.x}%;
                top: ${pos.y}%;
                width: 40px;
                height: 40px;
                background: radial-gradient(circle, #feca57 0%, rgba(254, 202, 87, 0.6) 50%, transparent 70%);
                border-radius: 50%;
                transform: translate(-50%, -50%);
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 0 20px rgba(254, 202, 87, 0.6);
                animation: calibPulse 1.5s infinite;
            `;

            const clickCountDisplay = document.createElement('div');
            clickCountDisplay.style.cssText = `
                position: absolute;
                bottom: -25px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 12px;
                color: white;
                background: rgba(0,0,0,0.5);
                padding: 2px 8px;
                border-radius: 10px;
            `;
            clickCountDisplay.textContent = `0/${CONFIG.CLICKS_PER_POINT}`;
            dot.appendChild(clickCountDisplay);

            dot.addEventListener('click', (e) => {
                e.stopPropagation();

                // Send calibration point to Python server
                const screenX = e.clientX;
                const screenY = e.clientY;
                sendCalibrationPoint(screenX, screenY);

                dotClicks[index]++;
                clickCountDisplay.textContent = `${dotClicks[index]}/${CONFIG.CLICKS_PER_POINT}`;

                // Visual feedback
                dot.style.transform = 'translate(-50%, -50%) scale(0.9)';
                setTimeout(() => dot.style.transform = 'translate(-50%, -50%) scale(1)', 100);

                const clicksEl = document.getElementById('calibration-clicks');
                if (clicksEl) {
                    clicksEl.textContent = `Clicks on current dot: ${dotClicks[index]}/${CONFIG.CLICKS_PER_POINT}`;
                }

                if (dotClicks[index] >= CONFIG.CLICKS_PER_POINT) {
                    dot.style.background = 'radial-gradient(circle, #00ffaa 0%, rgba(0, 255, 170, 0.6) 50%, transparent 70%)';
                    dot.style.animation = 'none';
                    dot.style.pointerEvents = 'none';
                    dot.style.opacity = '0.3';
                    clickCountDisplay.textContent = '✓';
                    clickCountDisplay.style.background = 'rgba(0,255,170,0.5)';

                    state.calibrationClicks++;

                    const statusEl = document.getElementById('calibration-status');
                    if (statusEl) {
                        statusEl.textContent = `Points: ${state.calibrationClicks}/${CONFIG.CALIBRATION_POINTS}`;
                    }

                    if (clicksEl) {
                        clicksEl.textContent = `Clicks on current dot: 0/${CONFIG.CLICKS_PER_POINT}`;
                    }

                    if (state.calibrationClicks >= CONFIG.CALIBRATION_POINTS) {
                        setTimeout(() => finishCalibration(), 500);
                    }
                }
            });

            overlay.appendChild(dot);
        });

        const styleTag = document.createElement('style');
        styleTag.textContent = `
            @keyframes calibPulse {
                0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
                50% { transform: translate(-50%, -50%) scale(1.2); opacity: 0.8; }
            }
        `;
        overlay.appendChild(styleTag);

        document.body.appendChild(overlay);

        const skipBtn = overlay.querySelector('#skip-calibration-btn');
        skipBtn.addEventListener('click', () => finishCalibration());

        return overlay;
    }

    function finishCalibration() {
        const overlay = document.getElementById('eye-calibration-overlay');
        if (overlay) {
            overlay.style.transition = 'opacity 0.5s ease';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }
        state.isCalibrated = true;
        setCalibrationDone();
        showNotification('Calibration Complete', '✅ Python eye tracking active!');
    }

    // ============== SIDEBAR UI ==============
    function createShadowSidebar() {
        const existingHost = document.getElementById('eye-sidebar-host');
        if (existingHost) existingHost.remove();

        const host = document.createElement('div');
        host.id = 'eye-sidebar-host';
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });

        const styles = document.createElement('style');
        styles.textContent = `
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }

            .sidebar-container {
                width: 140px;
                height: 100vh;
                display: flex;
                flex-direction: column;
                background: linear-gradient(135deg, rgba(15, 15, 35, 0.85) 0%, rgba(25, 25, 55, 0.9) 100%);
                backdrop-filter: blur(12px);
                border-left: 1px solid rgba(254, 202, 87, 0.3);
                box-shadow: -5px 0 30px rgba(0, 0, 0, 0.5);
            }

            .zone {
                flex: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                border-bottom: 1px solid rgba(254, 202, 87, 0.15);
                transition: all 0.3s ease;
                cursor: pointer;
            }

            .zone:last-child { border-bottom: none; }

            .zone:hover { background: rgba(254, 202, 87, 0.1); }

            .zone.active {
                background: linear-gradient(135deg, rgba(254, 202, 87, 0.2) 0%, rgba(200, 150, 50, 0.15) 100%);
                box-shadow: inset 0 0 30px rgba(254, 202, 87, 0.1);
            }

            .zone.active .zone-icon {
                transform: scale(1.15);
                filter: drop-shadow(0 0 12px rgba(254, 202, 87, 0.8));
            }

            .zone-icon {
                width: 32px;
                height: 32px;
                margin-bottom: 8px;
                transition: all 0.3s ease;
            }

            .zone-label {
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: rgba(255, 255, 255, 0.7);
                text-align: center;
                transition: all 0.3s ease;
                padding: 0 8px;
            }

            .zone.active .zone-label {
                color: #feca57;
                text-shadow: 0 0 10px rgba(254, 202, 87, 0.6);
            }

            .zone-progress {
                position: absolute;
                bottom: 0;
                left: 0;
                height: 3px;
                background: linear-gradient(90deg, #feca57 0%, #ff6b6b 100%);
                width: 0%;
                transition: width 0.1s linear;
            }

            .status-indicator {
                position: absolute;
                top: 8px;
                right: 8px;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #00ffaa;
                box-shadow: 0 0 8px rgba(0, 255, 170, 0.8);
                animation: pulse 2s infinite;
            }

            .status-indicator.inactive {
                background: #ff5050;
                animation: none;
            }

            .python-badge {
                position: absolute;
                top: 8px;
                left: 8px;
                font-size: 10px;
                background: linear-gradient(90deg, #306998, #ffd43b);
                color: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-weight: bold;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            .triggered {
                animation: triggerFlash 0.3s ease;
            }

            @keyframes triggerFlash {
                50% { transform: scale(0.95); background: rgba(255,255,255,0.2); }
            }
        `;

        const container = document.createElement('div');
        container.className = 'sidebar-container';

        const icons = {
            SCROLL_UP: `<svg viewBox="0 0 24 24" fill="none" stroke="#feca57" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
            SCROLL_DOWN: `<svg viewBox="0 0 24 24" fill="none" stroke="#feca57" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
            MEDIA: `<svg viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" fill="rgba(255,107,107,0.3)"/></svg>`,
            ASK_AI: `<svg viewBox="0 0 24 24" fill="none" stroke="#54a0ff" stroke-width="2"><circle cx="12" cy="12" r="10" fill="rgba(84,160,255,0.2)"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="#54a0ff"/></svg>`,
            KILL_SWITCH: `<svg viewBox="0 0 24 24" fill="none" stroke="#ff5050" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" fill="rgba(255,80,80,0.2)"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`
        };

        const labels = {
            SCROLL_UP: 'Scroll Up',
            SCROLL_DOWN: 'Scroll Down',
            MEDIA: 'Play / Pause',
            ASK_AI: 'Ask AI',
            KILL_SWITCH: 'Stop'
        };

        CONFIG.ZONES.forEach((zoneName, idx) => {
            const zone = document.createElement('div');
            zone.className = 'zone';
            zone.dataset.zone = zoneName;
            zone.style.position = 'relative';

            if (idx === 0) {
                const indicator = document.createElement('div');
                indicator.className = 'status-indicator';
                zone.appendChild(indicator);

                const badge = document.createElement('div');
                badge.className = 'python-badge';
                badge.textContent = 'PY';
                zone.appendChild(badge);
            }

            const icon = document.createElement('div');
            icon.className = 'zone-icon';
            icon.innerHTML = icons[zoneName];
            zone.appendChild(icon);

            const label = document.createElement('div');
            label.className = 'zone-label';
            label.textContent = labels[zoneName];
            zone.appendChild(label);

            const progress = document.createElement('div');
            progress.className = 'zone-progress';
            zone.appendChild(progress);

            zone.addEventListener('click', (e) => {
                e.preventDefault();
                zone.classList.add('triggered');
                setTimeout(() => zone.classList.remove('triggered'), 300);
                handleZoneAction(zoneName);
            });

            container.appendChild(zone);
        });

        shadow.appendChild(styles);
        shadow.appendChild(container);

        return { host, shadow, container };
    }

    // ============== GAZE DOT ==============
    function createGazeTargetDot() {
        const existingDot = document.getElementById('eye-gaze-target-dot');
        if (existingDot) existingDot.remove();

        const dot = document.createElement('div');
        dot.id = 'eye-gaze-target-dot';
        dot.style.cssText = `
            position: fixed;
            width: 28px;
            height: 28px;
            background: radial-gradient(circle, rgba(254, 202, 87, 0.95) 0%, rgba(254, 202, 87, 0.5) 35%, transparent 65%);
            border-radius: 50%;
            pointer-events: none;
            z-index: 2147483646;
            transform: translate(-50%, -50%);
            box-shadow: 0 0 25px rgba(254, 202, 87, 0.7), 0 0 50px rgba(255, 107, 107, 0.4);
            opacity: 0.95;
            will-change: left, top;
            animation: gazePulse 2s ease-in-out infinite;
        `;

        // Add keyframes for pulse animation
        const styleSheet = document.createElement('style');
        styleSheet.textContent = `
            @keyframes gazePulse {
                0%, 100% { transform: translate(-50%, -50%) scale(1); }
                50% { transform: translate(-50%, -50%) scale(1.1); }
            }
        `;
        document.head.appendChild(styleSheet);

        document.body.appendChild(dot);
        return dot;
    }

    // ============== ZONE DETECTION ==============
    function getZoneFromY(y) {
        const zoneHeight = window.innerHeight / CONFIG.ZONE_COUNT;
        const zoneIndex = Math.floor(y / zoneHeight);
        return CONFIG.ZONES[Math.min(zoneIndex, CONFIG.ZONE_COUNT - 1)];
    }

    function isInSidebar(x) {
        return x >= window.innerWidth - CONFIG.SIDEBAR_WIDTH;
    }

    // ============== SMOOTH CURSOR ANIMATION ==============
    function startCursorAnimation() {
        if (state.animationFrameId) return; // Already running

        function animate() {
            if (state.gazeX === null || state.gazeY === null) {
                state.animationFrameId = requestAnimationFrame(animate);
                return;
            }

            // Initialize display position if not set
            if (state.displayX === null) {
                state.displayX = state.gazeX;
                state.displayY = state.gazeY;
            }

            // Smooth interpolation towards target
            const smoothing = CONFIG.CURSOR_SMOOTHING;
            state.displayX += (state.gazeX - state.displayX) * smoothing;
            state.displayY += (state.gazeY - state.displayY) * smoothing;

            // Update the visual dot position
            const dot = document.getElementById('eye-gaze-target-dot');
            if (dot) {
                dot.style.left = `${state.displayX}px`;
                dot.style.top = `${state.displayY}px`;
            }

            // Update zone detection using the smoothed display position
            updateZoneFromGaze(state.displayX, state.displayY);

            state.animationFrameId = requestAnimationFrame(animate);
        }

        state.animationFrameId = requestAnimationFrame(animate);
    }

    function stopCursorAnimation() {
        if (state.animationFrameId) {
            cancelAnimationFrame(state.animationFrameId);
            state.animationFrameId = null;
        }
    }

    function updateGazePosition(x, y) {
        // Just update the target - animation loop handles the rest
        state.gazeX = x;
        state.gazeY = y;
    }

    function updateZoneFromGaze(x, y) {
        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;

        if (isInSidebar(x)) {
            const zone = getZoneFromY(y);

            if (zone !== state.currentZone) {
                if (zone !== state.pendingZone) {
                    state.pendingZone = zone;
                    state.zoneSwitchTime = performance.now();
                } else if (performance.now() - state.zoneSwitchTime >= CONFIG.ZONE_SWITCH_DELAY) {
                    state.currentZone = zone;
                    state.pendingZone = null;
                    state.dwellStartTime = performance.now();
                    stopScrolling();
                }
            } else {
                state.pendingZone = null;
            }

            if (state.currentZone) {
                const dwellDuration = performance.now() - state.dwellStartTime;
                const dwellProgress = Math.min(dwellDuration / CONFIG.DWELL_TIME, 1);

                updateZoneVisuals(host.shadowRoot, state.currentZone, dwellProgress);

                if (dwellDuration >= CONFIG.DWELL_TIME) {
                    handleZoneAction(state.currentZone);
                    state.dwellStartTime = performance.now();
                }
            }
        } else {
            if (state.currentZone) {
                state.currentZone = null;
                state.pendingZone = null;
                state.dwellStartTime = null;
                stopScrolling();
                updateZoneVisuals(host.shadowRoot, null, 0);
            }
        }
    }

    function updateZoneVisuals(shadow, activeZone, dwellProgress) {
        const zones = shadow.querySelectorAll('.zone');
        zones.forEach(zone => {
            const zoneName = zone.dataset.zone;
            const isActive = zoneName === activeZone;
            zone.classList.toggle('active', isActive);
            const progress = zone.querySelector('.zone-progress');
            if (progress) {
                progress.style.width = isActive ? `${dwellProgress * 100}%` : '0%';
            }
        });
    }

    function updateStatusIndicator(connected) {
        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;
        const indicator = host.shadowRoot.querySelector('.status-indicator');
        if (indicator) {
            indicator.classList.toggle('inactive', !connected);
        }
    }

    // ============== ZONE ACTIONS ==============
    function handleZoneAction(zone) {
        switch (zone) {
            case 'SCROLL_UP':
                window.scrollBy({ top: -200, behavior: 'smooth' });
                break;
            case 'SCROLL_DOWN':
                window.scrollBy({ top: 200, behavior: 'smooth' });
                break;
            case 'MEDIA':
                triggerMediaControl();
                break;
            case 'ASK_AI':
                triggerAskAI();
                break;
            case 'KILL_SWITCH':
                stopScrolling();
                state.isActive = false;
                updateStatusIndicator(false);
                showNotification('Control', '🛑 Eye tracking paused');
                setTimeout(() => {
                    state.isActive = true;
                    updateStatusIndicator(state.isConnected);
                    showNotification('Control', '✅ Eye tracking resumed');
                }, 3000);
                break;
        }
    }

    function startScrolling(direction) {
        if (state.scrollIntervalId) return;
        state.isScrolling = true;
        state.scrollDirection = direction;
        state.scrollIntervalId = setInterval(() => {
            window.scrollBy({ top: direction === 'up' ? -CONFIG.SCROLL_SPEED : CONFIG.SCROLL_SPEED });
        }, CONFIG.SCROLL_INTERVAL);
    }

    function stopScrolling() {
        if (state.scrollIntervalId) {
            clearInterval(state.scrollIntervalId);
            state.scrollIntervalId = null;
        }
        state.isScrolling = false;
    }

    function triggerMediaControl() {
        const video = document.querySelector('video');
        if (video) {
            if (video.paused) video.play().catch(() => { });
            else video.pause();
            showNotification('Media', video.paused ? '⏸️ Paused' : '▶️ Playing');
        }
    }

    // ============== NOTIFICATIONS ==============
    function showNotification(title, message) {
        const existingNotif = document.getElementById('eye-notification');
        if (existingNotif) existingNotif.remove();

        const notif = document.createElement('div');
        notif.id = 'eye-notification';
        notif.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, rgba(15, 15, 35, 0.95) 0%, rgba(25, 25, 55, 0.98) 100%);
            border: 1px solid rgba(254, 202, 87, 0.4);
            border-radius: 12px;
            padding: 16px 24px;
            z-index: 2147483647;
            color: white;
            font-family: 'Inter', sans-serif;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        `;
        notif.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; color: #feca57;">${title}</div>
            <div style="font-size: 16px; margin-top: 4px;">${message}</div>
        `;

        document.body.appendChild(notif);
        setTimeout(() => {
            notif.style.opacity = '0';
            notif.style.transition = 'opacity 0.3s';
            setTimeout(() => notif.remove(), 300);
        }, 2000);
    }

    // ============== ASK AI (PERPLEXITY) ==============
    async function triggerAskAI() {
        const selection = window.getSelection();
        const selectedText = selection ? selection.toString().trim() : '';

        const existingPanel = document.getElementById('eye-ai-panel');
        if (existingPanel) existingPanel.remove();

        const aiPanel = document.createElement('div');
        aiPanel.id = 'eye-ai-panel';
        aiPanel.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(135deg, rgba(15, 15, 35, 0.98) 0%, rgba(25, 25, 55, 0.99) 100%);
            border: 1px solid rgba(84, 160, 255, 0.4);
            border-radius: 16px;
            padding: 24px;
            z-index: 2147483647;
            color: white;
            font-family: 'Inter', sans-serif;
            min-width: 400px;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        `;

        aiPanel.innerHTML = `
            <button id="ai-close" style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.1);border:none;color:white;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:16px;">✕</button>
            <div style="font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #54a0ff;">🤖 Ask AI</div>
            <input type="text" id="ai-question-input" placeholder="Ask anything..." value="${selectedText ? `Explain: "${selectedText}"` : ''}" style="
                width: 100%;
                padding: 12px 16px;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(84, 160, 255, 0.3);
                border-radius: 8px;
                color: white;
                font-size: 14px;
                outline: none;
                margin-bottom: 16px;
            "/>
            <button id="ai-submit-btn" style="
                width: 100%;
                padding: 12px;
                background: linear-gradient(90deg, #54a0ff 0%, #00d2d3 100%);
                border: none;
                border-radius: 8px;
                color: white;
                font-weight: 600;
                cursor: pointer;
                margin-bottom: 16px;
            ">Ask Perplexity AI</button>
            <div id="ai-response" style="
                background: rgba(0,0,0,0.3);
                border-radius: 8px;
                padding: 16px;
                min-height: 100px;
                font-size: 14px;
                line-height: 1.6;
            "><span style="color: rgba(255,255,255,0.5);">Response will appear here...</span></div>
        `;

        document.body.appendChild(aiPanel);

        const closeBtn = aiPanel.querySelector('#ai-close');
        const input = aiPanel.querySelector('#ai-question-input');
        const submitBtn = aiPanel.querySelector('#ai-submit-btn');
        const responseDiv = aiPanel.querySelector('#ai-response');

        closeBtn.onclick = () => aiPanel.remove();
        input.focus();

        const askAI = async () => {
            const question = input.value.trim();
            if (!question) return;

            responseDiv.innerHTML = '<span style="color: #feca57;">⏳ Thinking...</span>';
            submitBtn.disabled = true;

            try {
                const response = await fetch('https://api.perplexity.ai/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${CONFIG.PERPLEXITY_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'sonar-pro',
                        messages: [
                            { role: 'system', content: 'You are a helpful AI. Be concise.' },
                            { role: 'user', content: `Page: ${document.title}\n\nQuestion: ${question}` }
                        ],
                        max_tokens: 1024
                    })
                });

                const data = await response.json();
                responseDiv.innerHTML = data.choices[0].message.content.replace(/\n/g, '<br>');
            } catch (error) {
                responseDiv.innerHTML = `<span style="color: #ff6b6b;">Error: ${error.message}</span>`;
            }

            submitBtn.disabled = false;
        };

        submitBtn.onclick = askAI;
        input.onkeypress = (e) => { if (e.key === 'Enter') askAI(); };
    }

    // ============== RECALIBRATE BUTTON ==============
    function createRecalibrationButton() {
        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;

        const container = host.shadowRoot.querySelector('.sidebar-container');
        if (!container) return;

        const style = document.createElement('style');
        style.textContent = `
            .recalibrate-btn {
                position: absolute;
                bottom: 8px;
                right: 8px;
                width: 24px;
                height: 24px;
                background: rgba(255,255,255,0.1);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.3s ease;
            }
            .recalibrate-btn:hover {
                background: rgba(255,255,255,0.2);
                transform: scale(1.1);
            }
        `;
        host.shadowRoot.appendChild(style);

        const firstZone = container.querySelector('.zone');
        if (firstZone) {
            const recalBtn = document.createElement('div');
            recalBtn.className = 'recalibrate-btn';
            recalBtn.innerHTML = '🔄';
            recalBtn.title = 'Recalibrate';
            recalBtn.onclick = (e) => {
                e.stopPropagation();
                resetCalibration();
                createCalibrationOverlay();
            };
            firstZone.appendChild(recalBtn);
        }
    }

    // ============== INITIALIZATION ==============
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setup);
        } else {
            setup();
        }
    }

    // ============== CAMERA PREVIEW ==============
    function createCameraPreview() {
        const existingPreview = document.getElementById('sharingan-camera-container');
        if (existingPreview) existingPreview.remove();

        const container = document.createElement('div');
        container.id = 'sharingan-camera-container';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            width: 340px;
            background: linear-gradient(135deg, rgba(15, 15, 35, 0.95) 0%, rgba(25, 25, 55, 0.98) 100%);
            border: 2px solid rgba(254, 202, 87, 0.4);
            border-radius: 12px;
            z-index: 2147483645;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            overflow: hidden;
            cursor: move;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 8px 12px;
            background: linear-gradient(90deg, rgba(254, 202, 87, 0.2) 0%, rgba(255, 107, 107, 0.2) 100%);
            border-bottom: 1px solid rgba(254, 202, 87, 0.3);
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <span style="color: #feca57; font-weight: 600; font-size: 12px;">📷 Camera Preview</span>
            <div style="display: flex; gap: 8px;">
                <button id="sharingan-minimize-btn" style="background: rgba(255,255,255,0.1); border: none; color: white; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 10px;">_</button>
                <button id="sharingan-close-preview-btn" style="background: rgba(255,107,107,0.3); border: none; color: white; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 10px;">✕</button>
            </div>
        `;
        container.appendChild(header);

        const previewWrapper = document.createElement('div');
        previewWrapper.id = 'sharingan-preview-wrapper';
        previewWrapper.style.cssText = `padding: 8px;`;

        const preview = document.createElement('img');
        preview.id = 'sharingan-camera-preview';
        preview.style.cssText = `
            width: 320px;
            height: 240px;
            border-radius: 8px;
            background: #1a1a2e;
            display: block;
        `;
        preview.alt = 'Camera Preview';
        previewWrapper.appendChild(preview);

        const statusBar = document.createElement('div');
        statusBar.style.cssText = `
            padding: 4px 8px;
            font-size: 10px;
            color: rgba(255,255,255,0.6);
            text-align: center;
        `;
        statusBar.innerHTML = '🟢 Face detection active | Green = face | Blue = eyes';
        previewWrapper.appendChild(statusBar);

        container.appendChild(previewWrapper);
        document.body.appendChild(container);

        // Make draggable
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            offsetX = e.clientX - container.offsetLeft;
            offsetY = e.clientY - container.offsetTop;
            container.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                container.style.left = (e.clientX - offsetX) + 'px';
                container.style.top = (e.clientY - offsetY) + 'px';
                container.style.bottom = 'auto';
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            container.style.cursor = 'move';
        });

        // Minimize button
        const minimizeBtn = container.querySelector('#sharingan-minimize-btn');
        minimizeBtn.onclick = () => {
            const wrapper = document.getElementById('sharingan-preview-wrapper');
            if (wrapper.style.display === 'none') {
                wrapper.style.display = 'block';
                minimizeBtn.textContent = '_';
            } else {
                wrapper.style.display = 'none';
                minimizeBtn.textContent = '□';
            }
        };

        // Close button
        const closeBtn = container.querySelector('#sharingan-close-preview-btn');
        closeBtn.onclick = () => {
            container.style.display = 'none';
        };

        return container;
    }

    function setup() {
        createShadowSidebar();
        createGazeTargetDot();
        createRecalibrationButton();
        createCameraPreview();  // Add camera preview

        // Start smooth cursor animation loop
        startCursorAnimation();

        // Connect to Python server
        setTimeout(() => {
            connectToServer();

            // Show calibration after connection attempt
            setTimeout(() => {
                createCalibrationOverlay();
            }, 2000);
        }, 500);

        window.addEventListener('resize', () => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'screen_size',
                    width: window.innerWidth,
                    height: window.innerHeight
                }));
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopScrolling();
                stopCursorAnimation();
            } else {
                startCursorAnimation();
            }
        });
    }

    init();
})();

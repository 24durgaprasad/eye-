(function () {
    const CONFIG = {
        SIDEBAR_WIDTH: 140,
        ZONE_COUNT: 5,
        DWELL_TIME: 650,           // Slightly increased for more intentional activation
        SCROLL_SPEED: 8,
        SCROLL_INTERVAL: 16,
        LERP_MARGIN: 0.08,          // Reduced margin for better edge detection

        // Advanced filtering parameters - OPTIMIZED FOR SPEED
        FILTER_ALPHA: 0.5,          // Higher = faster response (0.5 is responsive)
        KALMAN_ENABLED: true,       // Use Kalman filter for noise reduction
        MOVING_AVG_SIZE: 4,         // Reduced buffer = less latency
        VELOCITY_THRESHOLD: 1200,   // px/s - higher threshold = less rejection
        MIN_CONFIDENCE: 0.3,        // Lower threshold = more data accepted
        OUTLIER_THRESHOLD: 200,     // pixels - higher = less rejection

        // Enhanced calibration
        CALIBRATION_POINTS: 9,
        CLICKS_PER_POINT: 3,        // Multiple clicks per calibration point
        CALIBRATION_HOLD_TIME: 400, // ms to hold gaze at each point

        // Zone hysteresis (prevents flickering between zones)
        ZONE_HYSTERESIS: 20,        // pixels of overlap
        ZONE_SWITCH_DELAY: 100,     // ms before switching zones

        WATCHDOG_INTERVAL: 3000,
        WATCHDOG_TIMEOUT: 5000,
        PERPLEXITY_API_KEY: 'YOUR_API_KEY_HERE',
        ZONES: ['SCROLL_UP', 'SCROLL_DOWN', 'MEDIA', 'ASK_AI', 'KILL_SWITCH'],
        STORAGE_KEY: 'eyecontrol_calibrated'
    };

    let state = {
        isActive: true,
        isScrolling: false,
        scrollDirection: null,
        scrollIntervalId: null,
        currentZone: null,
        pendingZone: null,
        zoneSwitchTime: null,
        dwellStartTime: null,
        filteredX: null,
        filteredY: null,
        isWebGazerReady: false,
        isCalibrated: false,
        calibrationClicks: 0,
        lastGazeTime: 0,
        watchdogId: null,

        // Advanced smoothing state
        gazeBuffer: [],             // Moving average buffer
        lastRawX: null,
        lastRawY: null,
        lastTimestamp: null,
        velocityX: 0,
        velocityY: 0,

        // Kalman filter state - tuned for faster response
        // q = process noise (higher = trusts model less, faster adaptation)
        // r = measurement noise (lower = trusts measurements more, faster response)
        kalmanX: { x: 0, p: 1000, q: 8, r: 20 },
        kalmanY: { x: 0, p: 1000, q: 8, r: 20 }
    };

    function lerpCoordinate(value, viewportSize) {
        const minMargin = CONFIG.LERP_MARGIN * viewportSize;
        const maxMargin = (1 - CONFIG.LERP_MARGIN) * viewportSize;
        const range = maxMargin - minMargin;
        const normalized = (value - minMargin) / range;
        return Math.max(0, Math.min(1, normalized)) * viewportSize;
    }

    function applyLowPassFilter(newValue, oldValue) {
        if (oldValue === null) return newValue;
        return oldValue + CONFIG.FILTER_ALPHA * (newValue - oldValue);
    }

    // Advanced Kalman filter for optimal state estimation
    function kalmanFilter(measurement, kalmanState) {
        // Prediction step
        const predictedX = kalmanState.x;
        const predictedP = kalmanState.p + kalmanState.q;

        // Update step
        const k = predictedP / (predictedP + kalmanState.r); // Kalman gain
        kalmanState.x = predictedX + k * (measurement - predictedX);
        kalmanState.p = (1 - k) * predictedP;

        return kalmanState.x;
    }

    // Moving average for additional smoothing
    function addToGazeBuffer(x, y) {
        state.gazeBuffer.push({ x, y, time: performance.now() });

        // Keep only recent samples
        while (state.gazeBuffer.length > CONFIG.MOVING_AVG_SIZE) {
            state.gazeBuffer.shift();
        }
    }

    function getMovingAverage() {
        if (state.gazeBuffer.length === 0) return null;

        // Weighted moving average - more recent samples have higher weight
        let sumX = 0, sumY = 0, sumWeight = 0;
        const len = state.gazeBuffer.length;

        for (let i = 0; i < len; i++) {
            const weight = (i + 1) / len; // Linear weighting: older=lower, newer=higher
            sumX += state.gazeBuffer[i].x * weight;
            sumY += state.gazeBuffer[i].y * weight;
            sumWeight += weight;
        }

        return {
            x: sumX / sumWeight,
            y: sumY / sumWeight
        };
    }

    // Calculate velocity to detect saccades (rapid eye movements)
    function calculateVelocity(newX, newY, timestamp) {
        if (state.lastRawX === null || state.lastTimestamp === null) {
            state.lastRawX = newX;
            state.lastRawY = newY;
            state.lastTimestamp = timestamp;
            return { vx: 0, vy: 0, speed: 0 };
        }

        const dt = (timestamp - state.lastTimestamp) / 1000; // Convert to seconds
        if (dt <= 0) return { vx: state.velocityX, vy: state.velocityY, speed: Math.sqrt(state.velocityX ** 2 + state.velocityY ** 2) };

        const vx = (newX - state.lastRawX) / dt;
        const vy = (newY - state.lastRawY) / dt;
        const speed = Math.sqrt(vx * vx + vy * vy);

        state.lastRawX = newX;
        state.lastRawY = newY;
        state.lastTimestamp = timestamp;
        state.velocityX = vx;
        state.velocityY = vy;

        return { vx, vy, speed };
    }

    // Check if this is an outlier (sudden jump)
    function isOutlier(newX, newY) {
        if (state.filteredX === null || state.filteredY === null) return false;

        const distance = Math.sqrt(
            Math.pow(newX - state.filteredX, 2) +
            Math.pow(newY - state.filteredY, 2)
        );

        return distance > CONFIG.OUTLIER_THRESHOLD;
    }

    // Main advanced filtering pipeline - OPTIMIZED FOR SPEED
    function processGazeData(rawX, rawY, timestamp, eyeFeatures) {
        // Step 1: Check confidence threshold if available
        if (eyeFeatures && eyeFeatures.confidence !== undefined) {
            if (eyeFeatures.confidence < CONFIG.MIN_CONFIDENCE) {
                return null; // Reject low confidence data
            }
        }

        // Step 2: Apply coordinate normalization (LERP)
        const lerpedX = lerpCoordinate(rawX, window.innerWidth);
        const lerpedY = lerpCoordinate(rawY, window.innerHeight);

        // Step 3: Calculate velocity and detect saccades
        const velocity = calculateVelocity(lerpedX, lerpedY, timestamp);

        // During saccades, the gaze data is unreliable - skip update
        if (velocity.speed > CONFIG.VELOCITY_THRESHOLD) {
            return null;
        }

        // Step 4: Check for outliers (sudden jumps)
        if (isOutlier(lerpedX, lerpedY)) {
            return state.filteredX !== null ?
                { x: state.filteredX, y: state.filteredY } : null;
        }

        // Step 5: Apply Kalman filter ONLY (fast path)
        let filteredX, filteredY;
        if (CONFIG.KALMAN_ENABLED) {
            filteredX = kalmanFilter(lerpedX, state.kalmanX);
            filteredY = kalmanFilter(lerpedY, state.kalmanY);
        } else {
            // Fallback: simple low-pass filter
            filteredX = applyLowPassFilter(lerpedX, state.filteredX);
            filteredY = applyLowPassFilter(lerpedY, state.filteredY);
        }

        // Update state
        state.filteredX = filteredX;
        state.filteredY = filteredY;

        return { x: filteredX, y: filteredY };
    }

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

    function resetCalibration() {
        try {
            localStorage.removeItem(CONFIG.STORAGE_KEY);
            if (typeof webgazer !== 'undefined') {
                webgazer.clearData();
            }
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
            <div style="font-size: 48px; margin-bottom: 20px;">👁️</div>
            <h1 style="font-size: 32px; font-weight: 700; margin-bottom: 16px; background: linear-gradient(90deg, #00ffaa, #00ccff); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Sharingan</h1>
            <p style="font-size: 18px; color: rgba(255,255,255,0.8); margin-bottom: 10px;">For best accuracy, <strong>click each dot ${CONFIG.CLICKS_PER_POINT} times</strong> while looking directly at it</p>
            <p style="font-size: 14px; color: rgba(255,255,255,0.6); margin-bottom: 30px;">Keep your head still • Sit at arm's length from screen • Good lighting helps</p>
            <div id="calibration-status" style="font-size: 24px; font-weight: 600; color: #00ffaa; margin-bottom: 10px;">Points: 0/${CONFIG.CALIBRATION_POINTS}</div>
            <div id="calibration-clicks" style="font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 20px;">Click current dot: 0/${CONFIG.CLICKS_PER_POINT}</div>
            <p style="font-size: 14px; color: rgba(255,255,255,0.5);">Look directly at each dot while clicking • Calibration is saved automatically</p>
            <button id="skip-calibration-btn" style="
                margin-top: 20px;
                padding: 10px 20px;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: 8px;
                color: rgba(255,255,255,0.7);
                cursor: pointer;
                font-size: 12px;
            ">Skip Calibration (Less Accurate)</button>
        `;

        overlay.appendChild(content);

        const positions = [
            { x: 10, y: 10 }, { x: 50, y: 10 }, { x: 90, y: 10 },
            { x: 10, y: 50 }, { x: 50, y: 50 }, { x: 90, y: 50 },
            { x: 10, y: 90 }, { x: 50, y: 90 }, { x: 90, y: 90 }
        ];

        // Track clicks per dot
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
                background: radial-gradient(circle, #00ffaa 0%, rgba(0, 255, 170, 0.6) 50%, transparent 70%);
                border-radius: 50%;
                transform: translate(-50%, -50%);
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 0 20px rgba(0, 255, 170, 0.6);
                animation: calibPulse 1.5s infinite;
            `;

            // Add click counter display
            const clickCountDisplay = document.createElement('div');
            clickCountDisplay.className = 'click-count';
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
                white-space: nowrap;
            `;
            clickCountDisplay.textContent = `0/${CONFIG.CLICKS_PER_POINT}`;
            dot.appendChild(clickCountDisplay);

            dot.addEventListener('click', (e) => {
                e.stopPropagation();

                // Record click for WebGazer
                if (typeof webgazer !== 'undefined' && webgazer.recordScreenPosition) {
                    webgazer.recordScreenPosition(e.clientX, e.clientY, 'click');
                }

                dotClicks[index]++;
                clickCountDisplay.textContent = `${dotClicks[index]}/${CONFIG.CLICKS_PER_POINT}`;

                // Visual feedback per click
                dot.style.transform = 'translate(-50%, -50%) scale(0.9)';
                setTimeout(() => {
                    dot.style.transform = 'translate(-50%, -50%) scale(1)';
                }, 100);

                // Update current dot click counter
                const clicksEl = document.getElementById('calibration-clicks');
                if (clicksEl) {
                    clicksEl.textContent = `Click current dot: ${dotClicks[index]}/${CONFIG.CLICKS_PER_POINT}`;
                }

                // Check if this dot is complete
                if (dotClicks[index] >= CONFIG.CLICKS_PER_POINT) {
                    dot.style.background = 'radial-gradient(circle, #00ccff 0%, rgba(0, 200, 255, 0.6) 50%, transparent 70%)';
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

                    // Reset click counter for next dot
                    if (clicksEl) {
                        clicksEl.textContent = `Click current dot: 0/${CONFIG.CLICKS_PER_POINT}`;
                    }

                    if (state.calibrationClicks >= CONFIG.CALIBRATION_POINTS) {
                        setTimeout(() => {
                            finishCalibration();
                        }, 500);
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
        skipBtn.addEventListener('click', () => {
            finishCalibration();
        });

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
        showNotification('Calibration Complete', '✅ Eye tracking is now active!');
    }

    function startWatchdog() {
        if (state.watchdogId) {
            clearInterval(state.watchdogId);
        }

        state.watchdogId = setInterval(() => {
            if (!state.isCalibrated || !state.isWebGazerReady) return;

            const timeSinceLastGaze = Date.now() - state.lastGazeTime;

            if (state.lastGazeTime > 0 && timeSinceLastGaze > CONFIG.WATCHDOG_TIMEOUT) {
                console.log('[Sharingan] Watchdog: WebGazer appears frozen, attempting recovery...');
                recoverWebGazer();
            }
        }, CONFIG.WATCHDOG_INTERVAL);
    }

    function recoverWebGazer() {
        if (typeof webgazer === 'undefined') return;

        try {
            webgazer.pause();

            setTimeout(() => {
                webgazer.resume();
                state.lastGazeTime = Date.now();
                showNotification('Recovery', '🔄 Eye tracking resumed');
            }, 500);
        } catch (err) {
            console.error('[Sharingan] Recovery failed:', err);

            try {
                webgazer.end();
                setTimeout(() => {
                    initWebGazer();
                }, 1000);
            } catch (e) { }
        }
    }

    function createRecalibrationButton() {
        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;

        const container = host.shadowRoot.querySelector('.sidebar-container');
        if (!container) return;

        const recalBtn = document.createElement('div');
        recalBtn.className = 'recalibrate-btn';
        recalBtn.innerHTML = '🔄';
        recalBtn.title = 'Recalibrate Eye Tracking';

        const style = document.createElement('style');
        style.textContent = `
            .recalibrate-btn {
                position: absolute;
                bottom: 8px;
                left: 8px;
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
                z-index: 10;
            }
            .recalibrate-btn:hover {
                background: rgba(255,255,255,0.2);
                transform: scale(1.1);
            }
        `;
        host.shadowRoot.appendChild(style);

        recalBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resetCalibration();
            state.isCalibrated = false;
            state.calibrationClicks = 0;
            createCalibrationOverlay();
        });

        const firstZone = container.querySelector('.zone');
        if (firstZone) {
            firstZone.style.position = 'relative';
            firstZone.appendChild(recalBtn);
        }
    }

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
                -webkit-backdrop-filter: blur(12px);
                border-left: 1px solid rgba(0, 255, 170, 0.3);
                box-shadow: -5px 0 30px rgba(0, 0, 0, 0.5), inset 1px 0 0 rgba(255, 255, 255, 0.05);
            }

            .zone {
                flex: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                border-bottom: 1px solid rgba(0, 255, 170, 0.15);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
                cursor: pointer;
                user-select: none;
            }

            .zone:last-child {
                border-bottom: none;
            }

            .zone::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(180deg, transparent 0%, rgba(0, 255, 170, 0.05) 100%);
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            .zone:hover::before,
            .zone.active::before {
                opacity: 1;
            }

            .zone:hover {
                background: rgba(0, 255, 170, 0.1);
            }

            .zone:active {
                transform: scale(0.98);
            }

            .zone.active {
                background: linear-gradient(135deg, rgba(0, 255, 170, 0.15) 0%, rgba(0, 200, 150, 0.1) 100%);
                box-shadow: inset 0 0 30px rgba(0, 255, 170, 0.1);
            }

            .zone.active .zone-icon {
                transform: scale(1.15);
                filter: drop-shadow(0 0 12px rgba(0, 255, 170, 0.8));
            }

            .zone.active .zone-label {
                color: #00ffaa;
                text-shadow: 0 0 10px rgba(0, 255, 170, 0.6);
            }

            .zone-icon {
                width: 32px;
                height: 32px;
                margin-bottom: 8px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                filter: drop-shadow(0 0 4px rgba(0, 255, 170, 0.4));
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

            .zone-progress {
                position: absolute;
                bottom: 0;
                left: 0;
                height: 3px;
                background: linear-gradient(90deg, #00ffaa 0%, #00ccff 100%);
                width: 0%;
                transition: width 0.1s linear;
                box-shadow: 0 0 10px rgba(0, 255, 170, 0.6);
            }

            .zone-scroll-up { border-top: 2px solid rgba(0, 255, 170, 0.4); }
            .zone-scroll-down { }
            .zone-media { border-top: 1px solid rgba(255, 100, 200, 0.3); border-bottom: 1px solid rgba(255, 100, 200, 0.3); }
            .zone-media:hover { background: rgba(255, 100, 200, 0.1); }
            .zone-media.active { background: linear-gradient(135deg, rgba(255, 100, 200, 0.15) 0%, rgba(200, 80, 160, 0.1) 100%); }
            .zone-media.active .zone-icon { filter: drop-shadow(0 0 12px rgba(255, 100, 200, 0.8)); }
            .zone-media.active .zone-label { color: #ff64c8; text-shadow: 0 0 10px rgba(255, 100, 200, 0.6); }
            .zone-ask-ai { border-color: rgba(100, 150, 255, 0.3); }
            .zone-ask-ai:hover { background: rgba(100, 150, 255, 0.1); }
            .zone-ask-ai.active { background: linear-gradient(135deg, rgba(100, 150, 255, 0.15) 0%, rgba(80, 120, 200, 0.1) 100%); }
            .zone-ask-ai.active .zone-icon { filter: drop-shadow(0 0 12px rgba(100, 150, 255, 0.8)); }
            .zone-ask-ai.active .zone-label { color: #6496ff; text-shadow: 0 0 10px rgba(100, 150, 255, 0.6); }
            .zone-kill { border-top: 2px solid rgba(255, 80, 80, 0.4); }
            .zone-kill:hover { background: rgba(255, 80, 80, 0.1); }
            .zone-kill.active { background: linear-gradient(135deg, rgba(255, 80, 80, 0.2) 0%, rgba(200, 60, 60, 0.15) 100%); }
            .zone-kill.active .zone-icon { filter: drop-shadow(0 0 12px rgba(255, 80, 80, 0.8)); }
            .zone-kill.active .zone-label { color: #ff5050; text-shadow: 0 0 10px rgba(255, 80, 80, 0.6); }

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
                box-shadow: 0 0 8px rgba(255, 80, 80, 0.8);
                animation: none;
            }

            .status-indicator.frozen {
                background: #ffaa00;
                box-shadow: 0 0 8px rgba(255, 170, 0, 0.8);
                animation: none;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.6; transform: scale(0.9); }
            }

            .triggered {
                animation: triggerFlash 0.3s ease;
            }

            @keyframes triggerFlash {
                0% { transform: scale(1); }
                50% { transform: scale(0.95); background: rgba(255,255,255,0.2); }
                100% { transform: scale(1); }
            }
        `;

        const container = document.createElement('div');
        container.className = 'sidebar-container';

        const icons = {
            SCROLL_UP: `<svg viewBox="0 0 24 24" fill="none" stroke="#00ffaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
            SCROLL_DOWN: `<svg viewBox="0 0 24 24" fill="none" stroke="#00ffaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
            MEDIA: `<svg viewBox="0 0 24 24" fill="none" stroke="#ff64c8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="rgba(255,100,200,0.3)"/></svg>`,
            ASK_AI: `<svg viewBox="0 0 24 24" fill="none" stroke="#6496ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="rgba(100,150,255,0.2)"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="#6496ff"/></svg>`,
            KILL_SWITCH: `<svg viewBox="0 0 24 24" fill="none" stroke="#ff5050" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" fill="rgba(255,80,80,0.2)"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`
        };

        const labels = {
            SCROLL_UP: 'Scroll Up',
            SCROLL_DOWN: 'Scroll Down',
            MEDIA: 'Play / Pause',
            ASK_AI: 'Ask AI',
            KILL_SWITCH: 'Stop'
        };

        const zoneClasses = {
            SCROLL_UP: 'zone-scroll-up',
            SCROLL_DOWN: 'zone-scroll-down',
            MEDIA: 'zone-media',
            ASK_AI: 'zone-ask-ai',
            KILL_SWITCH: 'zone-kill'
        };

        CONFIG.ZONES.forEach((zoneName) => {
            const zone = document.createElement('div');
            zone.className = `zone ${zoneClasses[zoneName]}`;
            zone.dataset.zone = zoneName;

            const indicator = document.createElement('div');
            indicator.className = 'status-indicator';
            if (zoneName === 'SCROLL_UP') zone.appendChild(indicator);

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
                e.stopPropagation();
                zone.classList.add('triggered');
                setTimeout(() => zone.classList.remove('triggered'), 300);
                handleZoneAction(zoneName);
            });

            zone.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (zoneName === 'SCROLL_UP' || zoneName === 'SCROLL_DOWN') {
                    startScrolling(zoneName === 'SCROLL_UP' ? 'up' : 'down');
                }
            });

            zone.addEventListener('mouseup', (e) => {
                if (zoneName === 'SCROLL_UP' || zoneName === 'SCROLL_DOWN') {
                    stopScrolling();
                }
            });

            zone.addEventListener('mouseleave', (e) => {
                if (zoneName === 'SCROLL_UP' || zoneName === 'SCROLL_DOWN') {
                    stopScrolling();
                }
            });

            container.appendChild(zone);
        });

        shadow.appendChild(styles);
        shadow.appendChild(container);

        return { host, shadow, container };
    }

    function createGazeTargetDot() {
        const existingDot = document.getElementById('eye-gaze-target-dot');
        if (existingDot) existingDot.remove();

        const dot = document.createElement('div');
        dot.id = 'eye-gaze-target-dot';
        dot.style.cssText = `
            position: fixed;
            width: 20px;
            height: 20px;
            background: radial-gradient(circle, rgba(0, 255, 170, 0.9) 0%, rgba(0, 255, 170, 0.4) 40%, transparent 70%);
            border-radius: 50%;
            pointer-events: none;
            z-index: 2147483646;
            transform: translate(-50%, -50%);
            box-shadow: 0 0 15px rgba(0, 255, 170, 0.6), 0 0 30px rgba(0, 255, 170, 0.3);
            opacity: 0.8;
        `;
        document.body.appendChild(dot);
        return dot;
    }

    function getZoneFromY(y) {
        const viewportHeight = window.innerHeight;
        const zoneHeight = viewportHeight / CONFIG.ZONE_COUNT;
        const zoneIndex = Math.floor(y / zoneHeight);
        return CONFIG.ZONES[Math.min(zoneIndex, CONFIG.ZONE_COUNT - 1)];
    }

    function isInSidebar(x) {
        const viewportWidth = window.innerWidth;
        return x >= viewportWidth - CONFIG.SIDEBAR_WIDTH;
    }

    function startScrolling(direction) {
        if (state.scrollIntervalId) return;
        state.isScrolling = true;
        state.scrollDirection = direction;
        state.scrollIntervalId = setInterval(() => {
            const scrollAmount = direction === 'up' ? -CONFIG.SCROLL_SPEED : CONFIG.SCROLL_SPEED;
            window.scrollBy({ top: scrollAmount, behavior: 'auto' });
        }, CONFIG.SCROLL_INTERVAL);
    }

    function stopScrolling() {
        if (state.scrollIntervalId) {
            clearInterval(state.scrollIntervalId);
            state.scrollIntervalId = null;
        }
        state.isScrolling = false;
        state.scrollDirection = null;
    }

    function triggerMediaControl() {
        const keyEventInit = {
            key: 'k',
            code: 'KeyK',
            keyCode: 75,
            which: 75,
            bubbles: true,
            cancelable: true,
            view: window
        };

        const keydownEvent = new KeyboardEvent('keydown', keyEventInit);
        const keyupEvent = new KeyboardEvent('keyup', keyEventInit);

        document.dispatchEvent(keydownEvent);
        document.dispatchEvent(keyupEvent);
        window.dispatchEvent(keydownEvent);
        window.dispatchEvent(keyupEvent);

        document.body.dispatchEvent(keydownEvent);
        document.body.dispatchEvent(keyupEvent);

        const video = document.querySelector('video');
        if (video) {
            if (video.paused) {
                video.play().catch(() => { });
            } else {
                video.pause();
            }
        }

        showNotification('Media', video && !video.paused ? '▶️ Playing' : '⏸️ Paused');
    }

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
            backdrop-filter: blur(20px);
            border: 1px solid rgba(0, 255, 170, 0.4);
            border-radius: 12px;
            padding: 16px 24px;
            z-index: 2147483647;
            color: white;
            font-family: 'Inter', sans-serif;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
            animation: slideUp 0.3s ease;
        `;
        notif.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; color: #00ffaa;">${title}</div>
            <div style="font-size: 16px; margin-top: 4px;">${message}</div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideUp {
                from { transform: translateX(-50%) translateY(20px); opacity: 0; }
                to { transform: translateX(-50%) translateY(0); opacity: 1; }
            }
        `;
        notif.appendChild(style);

        document.body.appendChild(notif);

        setTimeout(() => {
            notif.style.transition = 'opacity 0.3s ease';
            notif.style.opacity = '0';
            setTimeout(() => notif.remove(), 300);
        }, 2000);
    }

    async function triggerAskAI() {
        const selection = window.getSelection();
        const selectedText = selection ? selection.toString().trim() : '';
        const pageTitle = document.title;
        const pageUrl = window.location.href;

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
            backdrop-filter: blur(20px);
            border: 1px solid rgba(100, 150, 255, 0.4);
            border-radius: 16px;
            padding: 24px;
            z-index: 2147483647;
            color: white;
            font-family: 'Inter', sans-serif;
            min-width: 400px;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 40px rgba(100, 150, 255, 0.2);
        `;

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = `
            position: absolute;
            top: 12px;
            right: 12px;
            background: rgba(255,255,255,0.1);
            border: none;
            color: white;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        `;
        closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255,255,255,0.2)';
        closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255,255,255,0.1)';
        closeBtn.onclick = () => aiPanel.remove();

        aiPanel.innerHTML = `
            <div style="font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #6496ff;">🤖 Ask AI</div>
            <div style="margin-bottom: 16px;">
                <input type="text" id="ai-question-input" placeholder="Ask anything about this page..." style="
                    width: 100%;
                    padding: 12px 16px;
                    background: rgba(255,255,255,0.1);
                    border: 1px solid rgba(100, 150, 255, 0.3);
                    border-radius: 8px;
                    color: white;
                    font-size: 14px;
                    outline: none;
                    transition: border 0.2s;
                "/>
            </div>
            <button id="ai-submit-btn" style="
                width: 100%;
                padding: 12px;
                background: linear-gradient(90deg, #6496ff 0%, #00ccff 100%);
                border: none;
                border-radius: 8px;
                color: white;
                font-weight: 600;
                cursor: pointer;
                font-size: 14px;
                margin-bottom: 16px;
                transition: opacity 0.2s;
            ">Ask Perplexity AI</button>
            <div id="ai-response" style="
                background: rgba(0,0,0,0.3);
                border-radius: 8px;
                padding: 16px;
                min-height: 100px;
                font-size: 14px;
                line-height: 1.6;
                color: rgba(255,255,255,0.9);
            ">
                <span style="color: rgba(255,255,255,0.5);">Response will appear here...</span>
            </div>
        `;

        aiPanel.appendChild(closeBtn);
        document.body.appendChild(aiPanel);

        const input = aiPanel.querySelector('#ai-question-input');
        const submitBtn = aiPanel.querySelector('#ai-submit-btn');
        const responseDiv = aiPanel.querySelector('#ai-response');

        if (selectedText) {
            input.value = `Explain this: "${selectedText}"`;
        }

        input.focus();

        submitBtn.addEventListener('click', async () => {
            const question = input.value.trim();
            if (!question) return;

            responseDiv.innerHTML = '<span style="color: #00ffaa;">⏳ Thinking...</span>';
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.6';

            try {
                const contextPrompt = `Page Title: ${pageTitle}\nPage URL: ${pageUrl}\n\nUser Question: ${question}`;

                const response = await fetch('https://api.perplexity.ai/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${CONFIG.PERPLEXITY_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'sonar-pro',
                        messages: [
                            {
                                role: 'system',
                                content: 'You are a helpful AI assistant. Provide concise, accurate answers. Format your response with clear paragraphs.'
                            },
                            {
                                role: 'user',
                                content: contextPrompt
                            }
                        ],
                        max_tokens: 1024,
                        temperature: 0.7
                    })
                });

                if (!response.ok) {
                    throw new Error(`API Error: ${response.status}`);
                }

                const data = await response.json();
                const answer = data.choices[0].message.content;

                responseDiv.innerHTML = answer.replace(/\n/g, '<br>');
            } catch (error) {
                responseDiv.innerHTML = `<span style="color: #ff5050;">Error: ${error.message}</span>`;
            }

            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                submitBtn.click();
            }
        });
    }

    function handleZoneAction(zone) {
        switch (zone) {
            case 'SCROLL_UP':
                window.scrollBy({ top: -200, behavior: 'smooth' });
                showNotification('Scroll', '⬆️ Scrolling Up');
                break;
            case 'SCROLL_DOWN':
                window.scrollBy({ top: 200, behavior: 'smooth' });
                showNotification('Scroll', '⬇️ Scrolling Down');
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
                    updateStatusIndicator(true);
                    showNotification('Control', '✅ Eye tracking resumed');
                }, 3000);
                break;
        }
    }

    function updateStatusIndicator(active, frozen = false) {
        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;
        const indicator = host.shadowRoot.querySelector('.status-indicator');
        if (indicator) {
            indicator.classList.remove('inactive', 'frozen');
            if (frozen) {
                indicator.classList.add('frozen');
            } else if (!active) {
                indicator.classList.add('inactive');
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

    function initWebGazer() {
        if (typeof webgazer === 'undefined') {
            console.error('[Sharingan] WebGazer not loaded');
            showNotification('Error', '❌ WebGazer library not found');
            return;
        }

        try {
            webgazer.setRegression('ridge')
                .setGazeListener((data, timestamp) => {
                    if (!data) return;

                    state.lastGazeTime = Date.now();

                    if (!state.isActive || !state.isCalibrated) return;

                    // Use the advanced filtering pipeline
                    const result = processGazeData(data.x, data.y, performance.now(), data);

                    if (result) {
                        updateGazePosition(result.x, result.y);
                    }
                })
                .saveDataAcrossSessions(true)
                .begin();

            webgazer.showVideoPreview(true)
                .showPredictionPoints(false)
                .applyKalmanFilter(true);

            setTimeout(() => {
                const videoContainer = document.getElementById('webgazerVideoContainer');
                if (videoContainer) {
                    videoContainer.style.cssText = `
                        position: fixed !important;
                        top: 10px !important;
                        left: 10px !important;
                        width: 160px !important;
                        height: 120px !important;
                        z-index: 2147483640 !important;
                        border-radius: 12px !important;
                        overflow: hidden !important;
                        border: 2px solid rgba(0, 255, 170, 0.4) !important;
                        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3) !important;
                    `;
                }

                const videoEl = document.getElementById('webgazerVideoFeed');
                if (videoEl) {
                    videoEl.style.cssText = `
                        width: 100% !important;
                        height: 100% !important;
                        object-fit: cover !important;
                    `;
                }
            }, 1000);

            state.isWebGazerReady = true;
            state.lastGazeTime = Date.now();

            startWatchdog();
        } catch (err) {
            console.error('[Sharingan] WebGazer init error:', err);
        }
    }

    function updateGazePosition(x, y) {
        const dot = document.getElementById('eye-gaze-target-dot');
        if (dot) {
            dot.style.left = `${x}px`;
            dot.style.top = `${y}px`;
        }

        const host = document.getElementById('eye-sidebar-host');
        if (!host || !host.shadowRoot) return;

        if (isInSidebar(x)) {
            const zone = getZoneFromY(y);

            // Zone hysteresis - prevent rapid switching
            if (zone !== state.currentZone) {
                if (zone !== state.pendingZone) {
                    // Start tracking a potential zone switch
                    state.pendingZone = zone;
                    state.zoneSwitchTime = performance.now();
                } else if (performance.now() - state.zoneSwitchTime >= CONFIG.ZONE_SWITCH_DELAY) {
                    // Zone switch confirmed after delay
                    state.currentZone = zone;
                    state.pendingZone = null;
                    state.dwellStartTime = performance.now();
                    stopScrolling();
                }
            } else {
                // Still in same zone, clear pending
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

    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setup);
        } else {
            setup();
        }
    }

    function setup() {
        createShadowSidebar();
        createGazeTargetDot();

        setTimeout(() => {
            initWebGazer();
            setTimeout(() => {
                createCalibrationOverlay();
                createRecalibrationButton();
            }, 1500);
        }, 500);

        window.addEventListener('resize', () => {
            // Reset all filtering state on resize
            state.filteredX = null;
            state.filteredY = null;
            state.gazeBuffer = [];
            state.lastRawX = null;
            state.lastRawY = null;
            state.lastTimestamp = null;
            state.velocityX = 0;
            state.velocityY = 0;
            state.kalmanX = { x: 0, p: 1000, q: 8, r: 20 };
            state.kalmanY = { x: 0, p: 1000, q: 8, r: 20 };
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopScrolling();
            }
        });
    }

    init();
})();
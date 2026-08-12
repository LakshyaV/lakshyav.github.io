/* paper & ink — control modes.
   Three ways to drive the page: trackpad (normal), hand gestures, or eye gaze.
   Both camera modes use pre-trained MediaPipe models loaded on demand and run
   entirely in the browser — no training, no upload, nothing leaves the device.

   Gesture: MediaPipe HandLandmarker. A skeleton is drawn over your hand, the
   index fingertip is the cursor, pinch-and-drag scrolls (pull up → down, Vision
   Pro style), a quick pinch clicks whatever is under the cursor.
   Gaze: MediaPipe FaceLandmarker. Your eyes move a cursor; a hard blink clicks.

   Everything degrades to trackpad on any error. */

(function () {
  "use strict";

  var root = document.documentElement;
  var entry = document.getElementById("entry");
  var hud = document.getElementById("control-hud");
  var hudCam = document.getElementById("hud-cam");
  var hudStatus = document.getElementById("hud-status");
  var hudExit = document.getElementById("hud-exit");
  if (!entry) return;

  try {
    if (sessionStorage.getItem("entry-done") === "1") root.classList.add("entry-done");
  } catch (_) {}

  var activeMode = null; // "gesture" | "gaze"
  var stopFns = [];
  var camStream = null;
  var overlayEl = null,
    octx = null,
    onResize = null;
  var cursorEl = null;

  /* ------------------------------ helpers ------------------------------- */
  function setStatus(text, live) {
    if (!hudStatus) return;
    hudStatus.textContent = text;
    hudStatus.classList.toggle("live", !!live);
  }

  function closeEntry() {
    entry.classList.add("closing");
    setTimeout(function () {
      root.classList.add("entry-done");
    }, 380);
    try {
      sessionStorage.setItem("entry-done", "1");
    } catch (_) {}
  }

  // Resolves once hudCam is playing the webcam. Shared by both camera modes.
  function ensureCamera() {
    return new Promise(function (resolve, reject) {
      if (camStream && hudCam.readyState >= 2) {
        resolve();
        return;
      }
      hud.hidden = false;
      setStatus("starting camera…", false);
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "user" }, audio: false })
        .then(function (stream) {
          camStream = stream;
          hudCam.srcObject = stream;
          stopFns.push(function () {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            hudCam.srcObject = null;
            camStream = null;
          });
          var done = false;
          function ready() {
            if (done) return;
            done = true;
            resolve();
          }
          hudCam.onloadeddata = ready;
          hudCam.play().then(ready).catch(ready);
        })
        .catch(reject);
    });
  }

  // Full-viewport canvas for the hand skeleton, drawn in CSS pixels.
  function ensureOverlay() {
    if (octx) return octx;
    overlayEl = document.createElement("canvas");
    overlayEl.className = "ctrl-overlay";
    document.body.appendChild(overlayEl);
    octx = overlayEl.getContext("2d");
    onResize = function () {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      overlayEl.width = window.innerWidth * dpr;
      overlayEl.height = window.innerHeight * dpr;
      overlayEl.style.width = window.innerWidth + "px";
      overlayEl.style.height = window.innerHeight + "px";
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return octx;
  }

  function moveCursor(x, y, state) {
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.className = "ctrl-cursor";
      document.body.appendChild(cursorEl);
    }
    cursorEl.style.transform = "translate(" + x + "px," + y + "px)";
    cursorEl.dataset.state = state || "idle";
    cursorEl.style.opacity = "1";
  }

  function spawnRipple(x, y) {
    var r = document.createElement("div");
    r.className = "ctrl-ripple";
    r.style.transform = "translate(" + x + "px," + y + "px)";
    document.body.appendChild(r);
    setTimeout(function () {
      r.remove();
    }, 520);
  }

  // Click the real DOM element under (x,y). The overlay + cursor are
  // pointer-events:none, so elementFromPoint already ignores them.
  function clickAt(x, y) {
    spawnRipple(x, y);
    var el = document.elementFromPoint(x, y);
    if (!el) return;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
      );
    });
    try {
      if (el.focus) el.focus();
    } catch (_) {}
  }

  function teardown() {
    activeMode = null;
    stopFns.forEach(function (fn) {
      try {
        fn();
      } catch (_) {}
    });
    stopFns = [];
    if (overlayEl) {
      window.removeEventListener("resize", onResize);
      overlayEl.remove();
      overlayEl = null;
      octx = null;
    }
    if (cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
    if (hud) hud.hidden = true;
  }

  function exitToTrackpad() {
    teardown();
  }
  if (hudExit) hudExit.addEventListener("click", exitToTrackpad);

  /* =========================== hand gestures ============================
     MediaPipe HandLandmarker. Topology + thresholds researched against the
     official docs (hands_connections.py; hand_landmarker web guide). */

  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];
  var G = {
    PINCH_ON: 0.34, // engage when dist(4,8)/handScale < this
    PINCH_OFF: 0.5, // release above this (hysteresis)
    SMOOTH: 0.5, // cursor EMA
    DRAG_THRESH_PX: 22, // move past this during a pinch → it's a drag, not a tap
    TAP_MAX_MS: 350,
    SCROLL_GAIN: 1.4,
    SCROLL_DEADZONE: 0.4,
    CLICK_DEBOUNCE_MS: 400,
  };

  async function startGesture() {
    try {
      await ensureCamera();
    } catch (_) {
      setStatus("camera blocked. using trackpad.", false);
      setTimeout(exitToTrackpad, 1600);
      return;
    }
    ensureOverlay();

    setStatus("loading the hand model…", false);
    var handLandmarker;
    try {
      var mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
      var vision = await mod.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      handLandmarker = await mod.HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 1,
      });
    } catch (_) {
      setStatus("couldn't load the model. using trackpad.", false);
      setTimeout(exitToTrackpad, 1800);
      return;
    }
    if (activeMode !== "gesture") {
      try {
        handLandmarker.close();
      } catch (_) {}
      return;
    }
    stopFns.push(function () {
      try {
        handLandmarker.close();
      } catch (_) {}
    });

    setStatus("pinch to click · pinch-drag to scroll", true);

    var rafId = 0;
    var lastVideoTime = -1;
    var lastLandmarks = null;
    var cx = window.innerWidth * 0.5,
      cy = window.innerHeight * 0.5,
      haveCursor = false;
    var pinching = false,
      pinchStartX = 0,
      pinchStartY = 0,
      pinchStartT = 0,
      isDrag = false,
      clickedThisPinch = false,
      lastScrollY = 0,
      lastClickT = 0;

    function dist(a, b) {
      var dx = a.x - b.x,
        dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function toScreen(lm, W, H) {
      return { x: (1 - lm.x) * W, y: lm.y * H }; // mirror X for a selfie cursor
    }

    function drawSkeleton(lms, W, H) {
      var i, p, s, e;
      octx.lineWidth = 4;
      octx.strokeStyle = "rgba(120,120,120,0.55)";
      octx.lineCap = "round";
      for (i = 0; i < HAND_CONNECTIONS.length; i++) {
        s = toScreen(lms[HAND_CONNECTIONS[i][0]], W, H);
        e = toScreen(lms[HAND_CONNECTIONS[i][1]], W, H);
        octx.beginPath();
        octx.moveTo(s.x, s.y);
        octx.lineTo(e.x, e.y);
        octx.stroke();
      }
      for (i = 0; i < lms.length; i++) {
        p = toScreen(lms[i], W, H);
        octx.beginPath();
        octx.arc(p.x, p.y, i === 8 ? 7 : 4, 0, Math.PI * 2);
        octx.fillStyle =
          i === 8 ? "rgba(80,150,255,0.95)" : i === 4 ? "rgba(255,150,60,0.95)" : "rgba(150,150,150,0.8)";
        octx.fill();
      }
    }

    function processHand(lms, W, H) {
      var now = performance.now();
      var tip = toScreen(lms[8], W, H);
      if (!haveCursor) {
        cx = tip.x;
        cy = tip.y;
        haveCursor = true;
      } else {
        cx += G.SMOOTH * (tip.x - cx);
        cy += G.SMOOTH * (tip.y - cy);
      }

      var ratio = dist(lms[4], lms[8]) / (dist(lms[0], lms[9]) || 1e-6);

      if (!pinching && ratio < G.PINCH_ON) {
        pinching = true;
        pinchStartX = cx;
        pinchStartY = cy;
        pinchStartT = now;
        isDrag = false;
        clickedThisPinch = false;
        lastScrollY = cy;
      } else if (pinching && ratio > G.PINCH_OFF) {
        var dur = now - pinchStartT;
        if (!isDrag && !clickedThisPinch && dur <= G.TAP_MAX_MS && now - lastClickT > G.CLICK_DEBOUNCE_MS) {
          clickAt(cx, cy);
          lastClickT = now;
          clickedThisPinch = true;
        }
        pinching = false;
      }

      if (pinching) {
        if (Math.hypot(cx - pinchStartX, cy - pinchStartY) > G.DRAG_THRESH_PX) isDrag = true;
        if (isDrag) {
          var dY = cy - lastScrollY;
          if (Math.abs(dY) > G.SCROLL_DEADZONE) window.scrollBy(0, -dY * G.SCROLL_GAIN);
          lastScrollY = cy;
        }
        moveCursor(cx, cy, "pinch");
        setStatus(isDrag ? "scrolling…" : "pinch", true);
      } else {
        moveCursor(cx, cy, "idle");
        setStatus("pinch to click · pinch-drag to scroll", true);
      }
    }

    function loop() {
      if (activeMode !== "gesture") return;
      rafId = requestAnimationFrame(loop);
      var W = window.innerWidth,
        H = window.innerHeight;
      octx.clearRect(0, 0, W, H);
      if (hudCam.readyState >= 2) {
        var t = hudCam.currentTime;
        if (t !== lastVideoTime) {
          lastVideoTime = t;
          var res;
          try {
            res = handLandmarker.detectForVideo(hudCam, performance.now());
          } catch (_) {
            res = null;
          }
          lastLandmarks = res && res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
          if (lastLandmarks) processHand(lastLandmarks, W, H);
          else {
            if (pinching) {
              pinching = false;
              isDrag = false;
            }
            setStatus("show me your hand ✋", true);
          }
        }
      }
      if (lastLandmarks) drawSkeleton(lastLandmarks, W, H);
    }
    rafId = requestAnimationFrame(loop);
    stopFns.push(function () {
      if (rafId) cancelAnimationFrame(rafId);
    });
  }

  /* ============================== eye gaze ==============================
     MediaPipe FaceLandmarker (iris + blendshapes). Indices and blink
     blendshape names verified against the official mesh + model. */

  var GAIN_X = 3.5,
    GAIN_Y = 3.0,
    ALPHA = 0.18,
    BLINK_THRESHOLD = 0.55,
    RELEASE_THRESHOLD = 0.3,
    MIN_CLOSE_MS = 220,
    BLINK_DEBOUNCE_MS = 600,
    CALIB_MS = 1500,
    EDGE_MARGIN = 24;
  var EYE_A = { iris: 468, c1: 33, c2: 133, up: 159, dn: 145 };
  var EYE_B = { iris: 473, c1: 362, c2: 263, up: 386, dn: 374 };

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function scoreOf(cats, name) {
    if (!cats) return 0;
    for (var i = 0; i < cats.length; i++) if (cats[i].categoryName === name) return cats[i].score;
    return 0;
  }
  function eyeFraction(lm, e) {
    var iris = lm[e.iris],
      a = lm[e.c1],
      b = lm[e.c2],
      t = lm[e.up],
      d = lm[e.dn];
    var minX = Math.min(a.x, b.x),
      w = Math.abs(b.x - a.x) || 1e-6;
    var minY = Math.min(t.y, d.y),
      h = Math.abs(d.y - t.y) || 1e-6;
    return { hx: (iris.x - minX) / w, vy: (iris.y - minY) / h };
  }

  async function startGaze() {
    try {
      await ensureCamera();
    } catch (_) {
      setStatus("camera blocked. using trackpad.", false);
      setTimeout(exitToTrackpad, 1600);
      return;
    }

    setStatus("loading the face model…", false);
    var faceLandmarker;
    try {
      var mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
      var vision = await mod.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      faceLandmarker = await mod.FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    } catch (_) {
      setStatus("couldn't load the model. using trackpad.", false);
      setTimeout(exitToTrackpad, 1800);
      return;
    }
    if (activeMode !== "gaze") {
      try {
        faceLandmarker.close();
      } catch (_) {}
      return;
    }
    stopFns.push(function () {
      try {
        faceLandmarker.close();
      } catch (_) {}
    });

    var dot = document.createElement("div");
    dot.className = "gaze-dot";
    document.body.appendChild(dot);
    function removeDot() {
      if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      dot = null;
    }
    stopFns.push(removeDot);

    var rafId = 0,
      lastVideoTime = -1;
    var phase = "calibrating",
      calStart = 0,
      calSumX = 0,
      calSumY = 0,
      calCount = 0,
      baseHx = 0.5,
      baseVy = 0.5;
    var smoothX = window.innerWidth / 2,
      smoothY = window.innerHeight / 2;
    var blinkState = "open",
      closeStart = 0,
      lastClickTime = 0;

    function processResult(res, now) {
      if (!res || !res.faceLandmarks || !res.faceLandmarks.length) {
        setStatus("center your face in view", true);
        return;
      }
      var lm = res.faceLandmarks[0];
      var cats = res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : null;
      var bl = scoreOf(cats, "eyeBlinkLeft"),
        br = scoreOf(cats, "eyeBlinkRight");
      var bothHigh = bl > BLINK_THRESHOLD && br > BLINK_THRESHOLD;
      var bothLow = bl < RELEASE_THRESHOLD && br < RELEASE_THRESHOLD;

      if (blinkState === "open") {
        if (bothHigh) {
          blinkState = "closing";
          closeStart = now;
        }
      } else if (blinkState === "closing") {
        if (bothLow) blinkState = "open";
        else if (bothHigh && now - closeStart >= MIN_CLOSE_MS) blinkState = "armed";
      } else if (blinkState === "armed") {
        if (bothLow) {
          if (phase === "tracking" && now - lastClickTime >= BLINK_DEBOUNCE_MS) {
            lastClickTime = now;
            moveCursor(smoothX, smoothY, "blink");
            clickAt(smoothX, smoothY);
            setStatus("click.", true);
          }
          blinkState = "open";
        }
      }

      if (blinkState === "closing" || blinkState === "armed") {
        moveCursor(smoothX, smoothY, "blink");
        return; // eyes shut → iris unreliable, hold cursor
      }

      var a = eyeFraction(lm, EYE_A),
        b = eyeFraction(lm, EYE_B);
      var hx = (a.hx + b.hx) / 2,
        vy = (a.vy + b.vy) / 2;

      if (phase === "calibrating") {
        if (calStart === 0) calStart = now;
        calSumX += hx;
        calSumY += vy;
        calCount++;
        var remain = Math.max(0, CALIB_MS - (now - calStart)) / 1000;
        setStatus("look at the dot… " + remain.toFixed(1) + "s", true);
        moveCursor(window.innerWidth / 2, window.innerHeight / 2, "idle");
        if (now - calStart >= CALIB_MS && calCount > 5) {
          baseHx = calSumX / calCount;
          baseVy = calSumY / calCount;
          phase = "tracking";
          removeDot();
          setStatus("look to move · hard blink to click", true);
        }
        return;
      }

      var vw = window.innerWidth,
        vh = window.innerHeight;
      var tx = vw / 2 - GAIN_X * vw * (hx - baseHx);
      var ty = vh / 2 + GAIN_Y * vh * (vy - baseVy);
      tx = clamp(tx, EDGE_MARGIN, vw - EDGE_MARGIN);
      ty = clamp(ty, EDGE_MARGIN, vh - EDGE_MARGIN);
      smoothX = ALPHA * tx + (1 - ALPHA) * smoothX;
      smoothY = ALPHA * ty + (1 - ALPHA) * smoothY;
      moveCursor(smoothX, smoothY, "idle");
    }

    function loop() {
      if (activeMode !== "gaze") return;
      var now = performance.now();
      if (hudCam.readyState >= 2 && hudCam.currentTime !== lastVideoTime) {
        lastVideoTime = hudCam.currentTime;
        try {
          processResult(faceLandmarker.detectForVideo(hudCam, now), now);
        } catch (_) {}
      }
      rafId = requestAnimationFrame(loop);
    }
    setStatus("look at the dot to calibrate…", true);
    rafId = requestAnimationFrame(loop);
    stopFns.push(function () {
      if (rafId) cancelAnimationFrame(rafId);
    });
  }

  /* ------------------------------ wire up ------------------------------- */
  entry.querySelectorAll(".mode").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.dataset.mode;
      closeEntry();
      teardown();
      if (mode === "gesture") {
        activeMode = "gesture";
        hud.hidden = false;
        startGesture();
      } else if (mode === "gaze") {
        activeMode = "gaze";
        hud.hidden = false;
        startGaze();
      }
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && activeMode) exitToTrackpad();
  });
})();

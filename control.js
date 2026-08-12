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
    // The fingertip's normalised position only spans a narrow central band of
    // the camera frame, so mapping it 1:1 to the screen made the cursor barely
    // move. GAIN amplifies movement around centre so a small, comfortable hand
    // motion reaches every edge. This was the "cursor doesn't move" bug.
    GAIN: 2.1,
    SMOOTH: 0.5, // cursor EMA
    // Pinch measured as thumb-tip→index-tip distance over the index finger's
    // own length (MCP 5 → tip 8): scale- and distance-invariant, unlike the
    // old wrist-based metric which was unreliable at different hand distances.
    PINCH_ON: 0.5, // engage below this
    PINCH_OFF: 0.72, // release above this (hysteresis)
    // Scroll is a JOYSTICK, not a drag: while pinched, how far your hand sits
    // (in raw normalised units) above/below where you pinched sets a continuous
    // scroll speed. So a small held offset scrolls a whole page — displacement
    // dragging couldn't, since it's capped by how far your hand can travel.
    SCROLL_DEADZONE: 0.04, // hold within this of the anchor = no scroll (lets you click)
    SCROLL_SPEED: 330, // (offset − deadzone) → px/frame; wider band = smoother control
    SCROLL_MAX: 46, // px/frame cap
    SCROLL_DIR: 1, // 1 = hand down scrolls down (joystick); -1 to invert
    CLICK_DEBOUNCE_MS: 350,
  };

  // Joystick scroll velocity from the hand's vertical offset from the pinch
  // anchor (raw normalised units). Exposed for tests.
  function gScrollVel(offset) {
    var mag = Math.abs(offset) - G.SCROLL_DEADZONE;
    if (mag <= 0) return 0;
    var v = G.SCROLL_DIR * (offset < 0 ? -1 : 1) * Math.min(mag * G.SCROLL_SPEED, G.SCROLL_MAX);
    return v;
  }

  // Pure mapping/pinch helpers — exposed for automated tests (no camera needed).
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function gDist(a, b) {
    var dx = a.x - b.x,
      dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function gRawScreen(lm, W, H) {
    return { x: (1 - lm.x) * W, y: lm.y * H }; // mirror X (selfie)
  }
  function gMapCursor(lm8, W, H, gain) {
    var mx = 1 - lm8.x,
      my = lm8.y;
    return {
      x: clamp01(0.5 + (mx - 0.5) * gain) * W,
      y: clamp01(0.5 + (my - 0.5) * gain) * H,
    };
  }
  function gPinchRatio(lms) {
    return gDist(lms[4], lms[8]) / (gDist(lms[5], lms[8]) || 1e-6);
  }
  // Natural / Vision-Pro scroll: hand up (cy decreases) → page scrolls down.
  function gScrollDelta(cyNow, cyPrev, gain) {
    return -(cyNow - cyPrev) * gain;
  }
  window.__ctrl = {
    clamp01: clamp01,
    dist: gDist,
    mapCursor: gMapCursor,
    pinchRatio: gPinchRatio,
    scrollDelta: gScrollDelta,
    scrollVel: gScrollVel,
    G: G,
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

    setStatus("move your hand · pinch to click · pinch-drag to scroll · esc to exit", true);

    var rafId = 0;
    var lastVideoTime = -1;
    var lastLandmarks = null;
    var cx = window.innerWidth * 0.5,
      cy = window.innerHeight * 0.5,
      haveCursor = false;
    var pinching = false,
      anchorHandY = 0, // raw normalised hand-Y where the pinch began
      scrolled = false, // did this pinch move the page? (then it's not a click)
      lastClickT = 0;

    // The hand IS the cursor: the skeleton is drawn at true size translated so
    // the index fingertip sits exactly at the pointer, and that fingertip is
    // rendered as a glowing ring — the cursor itself, not a separate dot.
    function drawSkeleton(lms, W, H) {
      var anchor = gRawScreen(lms[8], W, H);
      function place(lm) {
        var r = gRawScreen(lm, W, H);
        return { x: cx + (r.x - anchor.x), y: cy + (r.y - anchor.y) };
      }
      var i, p, s, e;
      octx.lineWidth = 3.5;
      octx.strokeStyle = "rgba(140,140,140,0.4)"; // faint bones
      octx.lineCap = "round";
      for (i = 0; i < HAND_CONNECTIONS.length; i++) {
        s = place(lms[HAND_CONNECTIONS[i][0]]);
        e = place(lms[HAND_CONNECTIONS[i][1]]);
        octx.beginPath();
        octx.moveTo(s.x, s.y);
        octx.lineTo(e.x, e.y);
        octx.stroke();
      }
      for (i = 0; i < lms.length; i++) {
        if (i === 8) continue; // fingertip drawn as the cursor below
        p = place(lms[i]);
        octx.beginPath();
        octx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        octx.fillStyle = i === 4 ? "rgba(200,140,80,0.7)" : "rgba(160,160,160,0.55)";
        octx.fill();
      }
      // the cursor: a filled dot + ring at the fingertip, reacting to pinch
      var col = pinching ? "80,150,255" : "40,40,40";
      octx.beginPath();
      octx.arc(cx, cy, pinching ? 8 : 6, 0, Math.PI * 2);
      octx.fillStyle = "rgba(" + col + ",0.95)";
      octx.fill();
      octx.beginPath();
      octx.arc(cx, cy, pinching ? 15 : 18, 0, Math.PI * 2);
      octx.strokeStyle = "rgba(" + col + ",0.9)";
      octx.lineWidth = 2;
      octx.stroke();
    }

    function processHand(lms, W, H) {
      var now = performance.now();
      var tip = gMapCursor(lms[8], W, H, G.GAIN); // amplified, mirrored
      if (!haveCursor) {
        cx = tip.x;
        cy = tip.y;
        haveCursor = true;
      } else {
        cx += G.SMOOTH * (tip.x - cx);
        cy += G.SMOOTH * (tip.y - cy);
      }

      var ratio = gPinchRatio(lms);
      var handY = lms[8].y; // raw normalised, for the scroll joystick

      if (!pinching && ratio < G.PINCH_ON) {
        // pinch begins — anchor here; decide click vs scroll on what follows
        pinching = true;
        anchorHandY = handY;
        scrolled = false;
      } else if (pinching && ratio > G.PINCH_OFF) {
        // pinch released — a pinch that never scrolled is a CLICK
        if (!scrolled && now - lastClickT > G.CLICK_DEBOUNCE_MS) {
          clickAt(cx, cy);
          lastClickT = now;
        }
        pinching = false;
      }

      // Cursor is drawn on the canvas at the fingertip (see drawSkeleton), so
      // no separate DOM dot here — the hand itself is the pointer.
      if (pinching) {
        var vel = gScrollVel(handY - anchorHandY); // joystick: offset → speed
        if (vel !== 0) {
          scrolled = true;
          window.scrollBy(0, vel);
          setStatus((vel < 0 ? "scrolling up ↑" : "scrolling down ↓") + " · esc to exit", true);
        } else {
          setStatus("hold to scroll · release to click · esc to exit", true);
        }
      } else {
        setStatus("move your hand · pinch to click · hold + move to scroll · esc to exit", true);
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
     MediaPipe FaceLandmarker with a 9-point calibration and head pose.
     Iris-only tracking couldn't do vertical; this learns a per-user linear
     map from [iris, head yaw/pitch, nose] → screen px via ridge least
     squares, which is what makes up/down work. Hard blink clicks. Press C
     to recalibrate. Indices, blendshape names, and the column-major 4x4
     transform layout were verified against the official MediaPipe docs. */

  async function startGaze() {
    var CALIB_POINTS = [
      [0.1, 0.1], [0.5, 0.1], [0.9, 0.1],
      [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
      [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
    ];
    var FRAMES_PER_POINT = 12;
    var SETTLE_MS = 500;
    var LAMBDA = 1e-3;
    var EMA_ALPHA = 0.25;
    var BLINK_ENTER = 0.55;
    var BLINK_EXIT = 0.3;
    var BLINK_HOLD_MS = 220;
    var BLINK_DEBOUNCE_MS = 700;

    var faceLandmarker = null;
    var wX = null, wY = null;
    var featMean = null, featStd = null;
    var stopped = false;
    var wantRecalib = false;
    var lastTs = -1;

    function raf() {
      return new Promise(function (r) {
        requestAnimationFrame(function (t) {
          r(t);
        });
      });
    }
    function sleep(ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    }
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }
    function dotp(w, f) {
      var s = 0;
      for (var i = 0; i < w.length; i++) s += w[i] * f[i];
      return s;
    }

    var calibDot = document.createElement("div");
    calibDot.className = "gaze-dot";
    document.body.appendChild(calibDot);

    function onKey(e) {
      if (e.key === "c" || e.key === "C") wantRecalib = true;
    }
    window.addEventListener("keydown", onKey);
    stopFns.push(function () {
      stopped = true;
      try {
        window.removeEventListener("keydown", onKey);
      } catch (e) {}
      try {
        if (calibDot && calibDot.parentNode) calibDot.parentNode.removeChild(calibDot);
      } catch (e) {}
      try {
        if (faceLandmarker) faceLandmarker.close();
      } catch (e) {}
    });

    // Solve A x = b (small dense system) via Gauss-Jordan + partial pivot.
    function solveLinearSystem(A, b) {
      var n = b.length;
      var M = [];
      for (var i = 0; i < n; i++) {
        M[i] = A[i].slice();
        M[i].push(b[i]);
      }
      for (var col = 0; col < n; col++) {
        var piv = col, maxv = Math.abs(M[col][col]);
        for (var r = col + 1; r < n; r++) {
          var av = Math.abs(M[r][col]);
          if (av > maxv) {
            maxv = av;
            piv = r;
          }
        }
        if (maxv < 1e-12) continue;
        if (piv !== col) {
          var tmp = M[piv];
          M[piv] = M[col];
          M[col] = tmp;
        }
        var pivotVal = M[col][col];
        for (var r2 = 0; r2 < n; r2++) {
          if (r2 === col) continue;
          var factor = M[r2][col] / pivotVal;
          if (factor === 0) continue;
          for (var c = col; c <= n; c++) M[r2][c] -= factor * M[col][c];
        }
      }
      var x = new Array(n);
      for (var k = 0; k < n; k++) {
        var d = M[k][k];
        x[k] = Math.abs(d) < 1e-12 ? 0 : M[k][n] / d;
      }
      return x;
    }

    // Ridge fit: w = (XᵀX + λI)⁻¹ Xᵀy.
    function ridgeFit(X, y, lambda) {
      var n = X.length, f = X[0].length;
      var A = [], bvec = new Array(f);
      for (var i = 0; i < f; i++) {
        A[i] = new Array(f);
        for (var j = 0; j < f; j++) A[i][j] = 0;
        bvec[i] = 0;
      }
      for (var s = 0; s < n; s++) {
        var xs = X[s];
        for (var a = 0; a < f; a++) {
          for (var b2 = 0; b2 < f; b2++) A[a][b2] += xs[a] * xs[b2];
          bvec[a] += xs[a] * y[s];
        }
      }
      for (var dd = 0; dd < f; dd++) A[dd][dd] += lambda;
      return solveLinearSystem(A, bvec);
    }

    // Head yaw/pitch from the column-major 4x4 transform: (r,c) = data[c*4+r].
    function headPose(matData) {
      if (!matData || matData.length < 16) return { yaw: 0, pitch: 0 };
      var r00 = matData[0], r10 = matData[1], r20 = matData[2];
      var r21 = matData[6], r22 = matData[10];
      var sy = Math.sqrt(r00 * r00 + r10 * r10);
      return { pitch: Math.atan2(r21, r22), yaw: Math.atan2(-r20, sy) };
    }

    function landmarksToFeatures(lms, matData) {
      function frac(v, a, b) {
        var d = b - a;
        return Math.abs(d) < 1e-6 ? 0.5 : (v - a) / d;
      }
      var L = lms[468], Lc1 = lms[33], Lc2 = lms[133], Lu = lms[159], Ld = lms[145];
      var R = lms[473], Rc1 = lms[362], Rc2 = lms[263], Ru = lms[386], Rd = lms[374];
      var irisHx = (frac(L.x, Lc1.x, Lc2.x) + frac(R.x, Rc1.x, Rc2.x)) / 2;
      var irisVy = (frac(L.y, Lu.y, Ld.y) + frac(R.y, Ru.y, Rd.y)) / 2;
      var pose = headPose(matData);
      var nose = lms[1];
      var eyeLineY = (Lc1.y + Lc2.y + Rc1.y + Rc2.y) / 4;
      var noseVy = nose.y - eyeLineY;
      return [irisHx, irisVy, pose.yaw, pose.pitch, noseVy, 1];
    }

    function standardizeRow(feats) {
      var out = new Array(feats.length);
      for (var j = 0; j < feats.length - 1; j++) out[j] = (feats[j] - featMean[j]) / featStd[j];
      out[feats.length - 1] = 1;
      return out;
    }

    function blinkScores(cls) {
      var out = { l: 0, r: 0 };
      if (!cls || !cls.categories) return out;
      var c = cls.categories;
      for (var i = 0; i < c.length; i++) {
        if (c[i].categoryName === "eyeBlinkLeft") out.l = c[i].score;
        else if (c[i].categoryName === "eyeBlinkRight") out.r = c[i].score;
      }
      return out;
    }

    function detect() {
      var ts = performance.now();
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      return faceLandmarker.detectForVideo(hudCam, ts);
    }

    try {
      await ensureCamera();
    } catch (e) {
      setStatus("camera blocked. using trackpad.", false);
      setTimeout(exitToTrackpad, 1600);
      return;
    }

    setStatus("loading the face model…", false);
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
        outputFacialTransformationMatrixes: true,
      });
    } catch (err) {
      setStatus("couldn't load the model. using trackpad.", false);
      setTimeout(exitToTrackpad, 1800);
      return;
    }
    if (activeMode !== "gaze") {
      try {
        faceLandmarker.close();
      } catch (e) {}
      return;
    }

    async function collectPoint() {
      var acc = null, count = 0, attempts = 0, lastVideoTime = -1;
      var maxAttempts = FRAMES_PER_POINT * 25;
      while (count < FRAMES_PER_POINT && attempts < maxAttempts && activeMode === "gaze" && !stopped && !wantRecalib) {
        attempts++;
        await raf();
        if (!hudCam || hudCam.currentTime === lastVideoTime) continue;
        lastVideoTime = hudCam.currentTime;
        var res = detect();
        if (!res || !res.faceLandmarks || !res.faceLandmarks.length) continue;
        var matData =
          res.facialTransformationMatrixes && res.facialTransformationMatrixes.length
            ? res.facialTransformationMatrixes[0].data
            : null;
        var f = landmarksToFeatures(res.faceLandmarks[0], matData);
        if (!acc) acc = f.slice();
        else for (var i = 0; i < acc.length; i++) acc[i] += f[i];
        count++;
      }
      if (!acc || count === 0) return null;
      for (var j = 0; j < acc.length; j++) acc[j] /= count;
      acc[acc.length - 1] = 1;
      return acc;
    }

    async function calibrate() {
      var raw = [], yX = [], yY = [];
      for (var i = 0; i < CALIB_POINTS.length; i++) {
        if (activeMode !== "gaze" || stopped) return false;
        var tx = CALIB_POINTS[i][0] * window.innerWidth;
        var ty = CALIB_POINTS[i][1] * window.innerHeight;
        calibDot.style.left = tx + "px";
        calibDot.style.top = ty + "px";
        calibDot.style.opacity = "1";
        calibDot.style.transform = "scale(1.6)";
        setStatus("look at the dot · calibrating " + (i + 1) + "/" + CALIB_POINTS.length, true);
        await sleep(SETTLE_MS);
        calibDot.style.transform = "scale(1)";
        var feats = await collectPoint();
        if (!feats) {
          setStatus("no face detected. center yourself and press C", true);
          return false;
        }
        raw.push(feats);
        yX.push(tx);
        yY.push(ty);
      }
      calibDot.style.opacity = "0";

      var f = raw[0].length;
      featMean = new Array(f);
      featStd = new Array(f);
      for (var c = 0; c < f - 1; c++) {
        var m = 0;
        for (var r = 0; r < raw.length; r++) m += raw[r][c];
        m /= raw.length;
        var v = 0;
        for (var r2 = 0; r2 < raw.length; r2++) {
          var d = raw[r2][c] - m;
          v += d * d;
        }
        v /= raw.length;
        featMean[c] = m;
        featStd[c] = Math.sqrt(v) || 1e-6;
      }
      featMean[f - 1] = 0;
      featStd[f - 1] = 1;

      var Xs = raw.map(standardizeRow);
      wX = ridgeFit(Xs, yX, LAMBDA);
      wY = ridgeFit(Xs, yY, LAMBDA);
      return true;
    }

    async function trackingLoop() {
      var sx = null, sy = null;
      var blinkOn = false, blinkStart = 0, lastClick = 0, lastVideoTime = -1;
      while (activeMode === "gaze" && !stopped && !wantRecalib) {
        await raf();
        if (!hudCam || hudCam.currentTime === lastVideoTime) continue;
        lastVideoTime = hudCam.currentTime;
        var res = detect();
        if (!res || !res.faceLandmarks || !res.faceLandmarks.length) continue;
        var matData =
          res.facialTransformationMatrixes && res.facialTransformationMatrixes.length
            ? res.facialTransformationMatrixes[0].data
            : null;
        var feats = standardizeRow(landmarksToFeatures(res.faceLandmarks[0], matData));
        var px = clamp(dotp(wX, feats), 0, window.innerWidth);
        var py = clamp(dotp(wY, feats), 0, window.innerHeight);
        sx = sx == null ? px : sx + EMA_ALPHA * (px - sx);
        sy = sy == null ? py : sy + EMA_ALPHA * (py - sy);

        var bs = blinkScores(res.faceBlendshapes && res.faceBlendshapes[0]);
        var now = performance.now();
        var bothClosed = bs.l >= BLINK_ENTER && bs.r >= BLINK_ENTER;
        var bothOpen = bs.l < BLINK_EXIT && bs.r < BLINK_EXIT;
        if (!blinkOn && bothClosed) {
          blinkOn = true;
          blinkStart = now;
        } else if (blinkOn && bothOpen) {
          var held = now - blinkStart;
          if (held >= BLINK_HOLD_MS && now - lastClick >= BLINK_DEBOUNCE_MS) {
            clickAt(sx, sy);
            lastClick = now;
            setStatus("click.", true);
          }
          blinkOn = false;
        }
        moveCursor(sx, sy, blinkOn ? "blink" : "idle");
      }
    }

    while (activeMode === "gaze" && !stopped) {
      var ok = await calibrate();
      if (!ok) {
        exitToTrackpad();
        return;
      }
      setStatus("look to move · hard blink to click · C to recalibrate", true);
      wantRecalib = false;
      await trackingLoop();
      if (!wantRecalib) break;
    }
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

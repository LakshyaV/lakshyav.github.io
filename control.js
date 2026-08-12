/* paper & ink — control modes.
   Two ways to drive the page: trackpad (normal) or hand gestures.
   Both camera modes use pre-trained MediaPipe models loaded on demand and run
   entirely in the browser — no training, no upload, nothing leaves the device.

   Gesture: MediaPipe HandLandmarker. The index fingertip is the cursor, a
   pinch clicks, and pinch + moving your whole hand scrolls (joystick).

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

  var activeMode = null; // "gesture"
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

  // Click the real DOM element under (x,y). The overlay + cursor are drawn on a
  // pointer-events:none canvas, so elementFromPoint returns the true element.
  function clickAt(x, y) {
    spawnRipple(x, y);
    var el = document.elementFromPoint(x, y);
    if (!el) return;
    // Fire pointer/mouse events for anything listening to them...
    ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach(function (type) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
      );
    });
    try {
      if (el.focus) el.focus();
    } catch (_) {}
    // ...then the native click, which reliably navigates links, submits, and
    // triggers onclick handlers (bubbles up from a child to its <a>/<button>).
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
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
    SCROLL_DEADZONE: 0.035, // hold within this of the anchor = no scroll (lets you click)
    SCROLL_SPEED: 700, // (offset − deadzone) → px/frame; wider band = smoother control
    SCROLL_MAX: 75, // px/frame cap
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
    clickAt: clickAt,
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
      anchorWristY = 0, // raw normalised WRIST-Y where the pinch began (stable
      // during a pinch, unlike the fingertip which moves toward the thumb — that
      // false-triggered scroll and suppressed every click)
      clickX = 0,
      clickY = 0, // cursor aim captured at pinch-start, before the fingertip drifts
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
      var wristY = lms[0].y; // raw normalised WRIST-Y — stable during a pinch

      if (!pinching && ratio < G.PINCH_ON) {
        // pinch begins — anchor the joystick to the wrist, and remember where
        // the cursor was aiming BEFORE the fingertip drifts toward the thumb
        pinching = true;
        anchorWristY = wristY;
        clickX = cx;
        clickY = cy;
        scrolled = false;
      } else if (pinching && ratio > G.PINCH_OFF) {
        // pinch released — a pinch that never scrolled is a CLICK, at the aim
        if (!scrolled && now - lastClickT > G.CLICK_DEBOUNCE_MS) {
          clickAt(clickX, clickY);
          lastClickT = now;
        }
        pinching = false;
      }

      // Cursor is drawn on the canvas at the fingertip (see drawSkeleton), so
      // no separate DOM dot here — the hand itself is the pointer.
      if (pinching) {
        var vel = gScrollVel(wristY - anchorWristY); // joystick: whole-hand offset
        if (vel !== 0) {
          scrolled = true;
          window.scrollBy(0, vel);
          setStatus((vel < 0 ? "scrolling up ↑" : "scrolling down ↓") + " · esc to exit", true);
        } else {
          setStatus("hold to scroll · release to click · esc to exit", true);
        }
      } else {
        setStatus("move your hand · pinch to click · pinch + move hand to scroll · esc to exit", true);
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
      }
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && activeMode) exitToTrackpad();
  });
})();

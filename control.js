/* paper & ink — control modes.
   The site can be driven three ways: trackpad (normal), hand gestures
   (MediaPipe Hand Landmarker), or gaze (WebGazer). Both camera modes use
   pre-trained, in-browser models loaded on demand — no training, no upload,
   nothing leaves the device. Everything degrades to trackpad on any error. */

(function () {
  "use strict";

  var root = document.documentElement;
  var entry = document.getElementById("entry");
  var hud = document.getElementById("control-hud");
  var hudCam = document.getElementById("hud-cam");
  var hudStatus = document.getElementById("hud-status");
  var hudExit = document.getElementById("hud-exit");
  if (!entry) return;

  // Skip the chooser if they already picked this session.
  try {
    if (sessionStorage.getItem("entry-done") === "1") root.classList.add("entry-done");
  } catch (_) {}

  var activeMode = null; // "gesture" | "gaze"
  var scrollVel = 0; // target px/frame, set by whichever tracker is live
  var rafScroll = 0;
  var stopFns = []; // teardown for the current mode

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

  function scrollLoop() {
    if (!activeMode) return;
    if (Math.abs(scrollVel) > 0.15) window.scrollBy(0, scrollVel);
    rafScroll = requestAnimationFrame(scrollLoop);
  }

  function teardown() {
    scrollVel = 0;
    activeMode = null;
    if (rafScroll) cancelAnimationFrame(rafScroll);
    stopFns.forEach(function (fn) {
      try {
        fn();
      } catch (_) {}
    });
    stopFns = [];
    if (hud) hud.hidden = true;
  }

  function exitToTrackpad() {
    teardown();
  }
  if (hudExit) hudExit.addEventListener("click", exitToTrackpad);

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("failed to load " + src));
      };
      document.head.appendChild(s);
    });
  }

  function toggleIsland() {
    var island = document.getElementById("island");
    if (island) island.classList.toggle("open");
  }

  /* --------------------------- hand gestures ---------------------------- */
  async function startGesture() {
    hud.hidden = false;
    hud.classList.remove("no-cam");
    setStatus("starting camera…");
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    } catch (_) {
      setStatus("camera blocked. using trackpad.");
      setTimeout(exitToTrackpad, 1800);
      return;
    }
    hudCam.srcObject = stream;
    await hudCam.play().catch(function () {});
    stopFns.push(function () {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      hudCam.srcObject = null;
    });

    setStatus("loading the hand model…");
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
      setStatus("couldn't load the model. using trackpad.");
      setTimeout(exitToTrackpad, 2000);
      return;
    }
    stopFns.push(function () {
      try {
        handLandmarker.close();
      } catch (_) {}
    });

    setStatus("raise or lower your hand · pinch to toggle player", true);
    activeMode = "gesture";
    scrollLoop();

    var pinched = false;
    var lastVideoTime = -1;
    var raf = 0;
    function tick() {
      if (activeMode !== "gesture") return;
      raf = requestAnimationFrame(tick);
      if (hudCam.currentTime === lastVideoTime || hudCam.readyState < 2) return;
      lastVideoTime = hudCam.currentTime;
      var res;
      try {
        res = handLandmarker.detectForVideo(hudCam, performance.now());
      } catch (_) {
        return;
      }
      if (!res || !res.landmarks || !res.landmarks.length) {
        scrollVel = 0;
        setStatus("show me your hand ✋", true);
        return;
      }
      var lm = res.landmarks[0];
      var wristY = lm[0].y; // 0 top of frame … 1 bottom
      // dead zone in the middle third; ramp toward the edges
      var v = 0;
      if (wristY < 0.38) v = -((0.38 - wristY) / 0.38) * 16;
      else if (wristY > 0.62) v = ((wristY - 0.62) / 0.38) * 16;
      scrollVel = v;
      setStatus(v < -1 ? "scrolling up ↑" : v > 1 ? "scrolling down ↓" : "hold · pinch to toggle player", true);

      // pinch = thumb tip (4) close to index tip (8)
      var dx = lm[4].x - lm[8].x;
      var dy = lm[4].y - lm[8].y;
      var pinchNow = Math.hypot(dx, dy) < 0.06;
      if (pinchNow && !pinched) toggleIsland();
      pinched = pinchNow;
    }
    tick();
    stopFns.push(function () {
      if (raf) cancelAnimationFrame(raf);
    });
  }

  /* ------------------------------- gaze --------------------------------- */
  async function startGaze() {
    hud.hidden = false;
    hud.classList.add("no-cam"); // webgazer shows its own preview
    setStatus("starting eye tracking…");
    try {
      await loadScript("https://webgazer.cs.brown.edu/webgazer.js");
    } catch (_) {
      setStatus("couldn't load eye tracking. using trackpad.");
      setTimeout(exitToTrackpad, 2000);
      return;
    }
    if (!window.webgazer) {
      setStatus("eye tracking unavailable. using trackpad.");
      setTimeout(exitToTrackpad, 2000);
      return;
    }

    activeMode = "gaze";
    scrollLoop();

    try {
      window.webgazer
        .setRegression("ridge")
        .showVideoPreview(true)
        .showPredictionPoints(false)
        .setGazeListener(function (data) {
          if (!data || activeMode !== "gaze") return;
          var vh = window.innerHeight;
          var y = data.y;
          var v = 0;
          if (y < vh * 0.26) v = -((vh * 0.26 - y) / (vh * 0.26)) * 15;
          else if (y > vh * 0.74) v = ((y - vh * 0.74) / (vh * 0.26)) * 15;
          scrollVel = Math.max(-15, Math.min(15, v));
        })
        .begin();
    } catch (_) {
      setStatus("eye tracking failed to start. using trackpad.");
      setTimeout(exitToTrackpad, 2000);
      return;
    }

    setStatus("look near the top or bottom edge to scroll", true);
    stopFns.push(function () {
      try {
        window.webgazer.clearGazeListener();
        window.webgazer.end();
      } catch (_) {}
      var vc = document.getElementById("webgazerVideoContainer");
      if (vc) vc.remove();
    });
  }

  /* ------------------------------ wire up ------------------------------- */
  entry.querySelectorAll(".mode").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var mode = btn.dataset.mode;
      closeEntry();
      teardown(); // clear any prior mode
      if (mode === "gesture") startGesture();
      else if (mode === "gaze") startGaze();
      // trackpad: nothing to start
    });
  });

  // Escape always drops back to trackpad.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && activeMode) exitToTrackpad();
  });
})();

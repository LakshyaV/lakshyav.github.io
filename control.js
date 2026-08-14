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
  var CLICKABLE_SEL =
    "a[href], button, [role=button], input, textarea, label, summary, .chip, .mode, .icon-link, .sd, .ictl, .island-compact";

  // Nearest clickable element within r px of (x,y) — a magnetic hit test so an
  // imprecise camera cursor still lands on small links.
  function nearestClickable(x, y, r) {
    var best = null,
      bestD = r * r;
    var els = document.querySelectorAll(CLICKABLE_SEL);
    for (var i = 0; i < els.length; i++) {
      var b = els[i].getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || b.bottom < 0 || b.top > window.innerHeight) continue;
      var nx = Math.max(b.left, Math.min(x, b.right));
      var ny = Math.max(b.top, Math.min(y, b.bottom));
      var dx = x - nx,
        dy = y - ny,
        d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = els[i];
      }
    }
    return best;
  }

  function clickAt(x, y) {
    spawnRipple(x, y);
    var direct = document.elementFromPoint(x, y);
    var target = (direct && direct.closest && direct.closest(CLICKABLE_SEL)) || nearestClickable(x, y, 60);
    if (!target) return;

    // Links: open target=_blank ones in a NEW TAB (best-effort — a synthetic
    // pinch isn't a trusted gesture, so the browser may need pop-ups allowed
    // for this site; if it blocks the tab we fall back to same-tab so the link
    // still works). In-page / same-tab links navigate directly.
    var a = target.matches && target.matches("a[href]") ? target : target.closest && target.closest("a[href]");
    if (a && a.href) {
      if (a.target === "_blank") {
        var win = window.open(a.href, "_blank", "noopener");
        if (!win) window.location.href = a.href; // popup blocked → same tab
      } else {
        window.location.href = a.href;
      }
      return;
    }
    // Everything else (buttons, toggles, chips): fire pointer/mouse events then click.
    ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach(function (type) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
      );
    });
    try {
      if (target.focus) target.focus();
    } catch (_) {}
    if (typeof target.click === "function") target.click();
    else
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
      );
  }

  function teardown() {
    activeMode = null;
    try {
      Keyboard.hide();
    } catch (_) {}
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
    // motion reaches every edge. Lower gain = the cursor tracks the hand more
    // directly (feels like the hand IS the pointer), at the cost of a little
    // reach.
    GAIN: 1.7,
    SMOOTH: 0.62, // cursor EMA — higher = snappier, tracks the hand tighter
    // Pinch measured as thumb-tip→index-tip distance over the index finger's
    // own length (MCP 5 → tip 8): scale- and distance-invariant, unlike the
    // old wrist-based metric which was unreliable at different hand distances.
    PINCH_ON: 0.45, // engage below this
    PINCH_OFF: 0.62, // release above this (hysteresis) — lower so release always registers
    // GRAB-DRAG scroll: while pinched, the page follows the hand 1:(DRAG_GAIN)
    // the instant it moves — no displacement threshold, no "hold it at the edge
    // to build speed". Releasing with speed flings, then it glides to a stop.
    SCROLL_GRACE_MS: 90, // ignore the finger's settle drift right after a pinch
    DRAG_GAIN: 7.5, // page px scrolled per screen px the fingertip moves
    CLICK_MOVE_TOL: 12, // total fingertip travel under which a pinch stays a click
    MOMENTUM_SEED: 1.0, // fraction of the last drag speed carried into the fling
    FRICTION: 0.95, // per-frame momentum decay after release (higher = glides longer)
    FLING_MIN: 1.5, // min drag speed (px/frame) that starts a fling
    CLICK_DEBOUNCE_MS: 300,
  };

  // Page pixels to scroll for a vertical fingertip move of dyPx this frame.
  // Hand up (dy < 0) scrolls the page DOWN (grab/Vision-Pro feel). Exposed for tests.
  function gDragScroll(dyPx) {
    return -dyPx * G.DRAG_GAIN;
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

  /* ===================== keyboard: poke-typing config =====================
     Depth (z) is the noisiest landmark axis on one camera, so a poke is NOT
     gated on a raw threshold. We take a distance-invariant forward signal
     (index tip pushed past the palm plane, from worldLandmarks in metres),
     One-Euro filter it, and fire on displacement-past-baseline AND velocity,
     with hysteresis + a refractory period + a required retract. Pinch is kept
     as a reliable fallback. Constants from research; tune on real hardware. */
  var KB = {
    GAIN: 1.12, // pointing amplification over the keys — low so it's easy to control
    SMOOTH: 0.4, // aim EMA — lower = steadier (more smoothing), less twitchy
    REFRACTORY_MS: 220, // min gap between key presses
    BASELINE_EMA: 0.02, // slow drift tracking of the resting finger extension
    // metric from worldLandmarks (metres) — distance-invariant, preferred
    world: { FIRE_DISP: 0.02, RELEASE_DISP: 0.01, FIRE_VEL: 0.15 },
    // fallback from normalized z (tip8 − mcp5) if worldLandmarks is absent
    norm: { FIRE_DISP: 0.045, RELEASE_DISP: 0.022, FIRE_VEL: 0.4 },
  };

  // One-Euro filter (Casiez et al.) — adapts smoothing to speed: steady when
  // still, responsive on a fast jab. Better than EMA for a signal we threshold.
  function makeOneEuro(minCutoff, beta, dCutoff) {
    var xPrev = null,
      dxPrev = 0,
      tPrev = null;
    function alpha(cutoff, dt) {
      var tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    return function (x, tMs) {
      if (xPrev === null) {
        xPrev = x;
        tPrev = tMs;
        return x;
      }
      var dt = (tMs - tPrev) / 1000;
      if (dt <= 0) dt = 1 / 60;
      tPrev = tMs;
      var dx = (x - xPrev) / dt;
      dxPrev = dxPrev + alpha(dCutoff, dt) * (dx - dxPrev);
      var cutoff = minCutoff + beta * Math.abs(dxPrev);
      xPrev = xPrev + alpha(cutoff, dt) * (x - xPrev);
      return xPrev;
    };
  }

  // Unit normal of the palm plane (wrist 0, index-MCP 5, pinky-MCP 17),
  // oriented toward the camera so a forward poke reads positive for either hand.
  function palmNormal(w0, w5, w17) {
    var ax = w5.x - w0.x,
      ay = w5.y - w0.y,
      az = w5.z - w0.z;
    var bx = w17.x - w0.x,
      by = w17.y - w0.y,
      bz = w17.z - w0.z;
    var nx = ay * bz - az * by,
      ny = az * bx - ax * bz,
      nz = ax * by - ay * bx;
    var m = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1e-6;
    nx /= m;
    ny /= m;
    nz /= m;
    if (nz > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    } // smaller z = nearer the camera
    return { x: nx, y: ny, z: nz };
  }

  // Forward-extension signal: how far the index tip pokes past its own knuckle
  // along the palm normal. Metres if world landmarks are given, else normalized.
  function gForwardSignal(Lnorm, Wworld) {
    if (Wworld) {
      var n = palmNormal(Wworld[0], Wworld[5], Wworld[17]);
      return (
        (Wworld[8].x - Wworld[5].x) * n.x +
        (Wworld[8].y - Wworld[5].y) * n.y +
        (Wworld[8].z - Wworld[5].z) * n.z
      );
    }
    return Lnorm[5].z - Lnorm[8].z; // −z = nearer; tip nearer than knuckle ⇒ positive
  }

  // Assign each detected hand to a stable slot (0/1) by handedness label, so
  // per-hand poke state doesn't cross-contaminate when hand order shuffles.
  function assignSlots(res) {
    var out = [],
      used = [false, false];
    var hands = res.landmarks || [];
    for (var i = 0; i < hands.length && i < 2; i++) {
      var hd = res.handedness && res.handedness[i] && res.handedness[i][0];
      var slot = hd && hd.categoryName === "Right" ? 1 : 0;
      if (used[slot]) slot = slot === 0 ? 1 : 0;
      if (used[slot]) continue;
      used[slot] = true;
      out.push({ i: i, slot: slot });
    }
    return out;
  }

  /* ===================== the glass keyboard ===================== */
  var Keyboard = (function () {
    var el = null,
      scrim = null,
      tips = [null, null],
      built = false,
      shifted = false,
      isOpenFlag = false,
      hoverKey = [null, null];
    var ROWS = [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
      ["close", ",", "space", ".", "return"],
    ];
    function label(k) {
      return k === "shift" ? "⇧" : k === "backspace" ? "⌫" : k === "return" ? "return" : k === "space" ? "space" : k === "close" ? "⌄" : k;
    }
    function cls(k) {
      if (k === "space") return "vkb-key space";
      if (k === "shift" || k === "backspace" || k === "return" || k === "close") return "vkb-key wide";
      return "vkb-key";
    }
    function ta() {
      return document.getElementById("mail-input");
    }
    function build() {
      if (built) return;
      built = true;
      // blurred backdrop that dims the whole page behind the keyboard + box
      scrim = document.createElement("div");
      scrim.className = "kb-scrim";
      scrim.setAttribute("aria-hidden", "true");
      document.body.appendChild(scrim);
      el = document.createElement("div");
      el.className = "vkb";
      el.setAttribute("aria-hidden", "true");
      ROWS.forEach(function (row) {
        var r = document.createElement("div");
        r.className = "vkb-row";
        row.forEach(function (k) {
          var b = document.createElement("div");
          b.className = cls(k);
          b.dataset.key = k;
          b.textContent = label(k);
          b.addEventListener("mousedown", function (e) {
            e.preventDefault(); // never steal focus from the textarea
          });
          b.addEventListener("click", function () {
            fire(k, b);
          });
          r.appendChild(b);
        });
        el.appendChild(r);
      });
      document.body.appendChild(el);
      for (var i = 0; i < 2; i++) {
        var t = document.createElement("div");
        t.className = "vkb-tip";
        document.body.appendChild(t);
        tips[i] = t;
      }
    }
    function setShift(v) {
      shifted = v;
      var sk = el && el.querySelector('[data-key="shift"]');
      if (sk) sk.classList.toggle("active", shifted);
    }
    function insert(t, ch) {
      var s = t.selectionStart,
        e = t.selectionEnd;
      if (s == null) {
        t.value += ch;
      } else {
        t.value = t.value.slice(0, s) + ch + t.value.slice(e);
        var p = s + ch.length;
        try {
          t.selectionStart = t.selectionEnd = p;
        } catch (_) {}
      }
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function back(t) {
      var s = t.selectionStart,
        e = t.selectionEnd;
      if (s == null) t.value = t.value.slice(0, -1);
      else if (s !== e) {
        t.value = t.value.slice(0, s) + t.value.slice(e);
        try {
          t.selectionStart = t.selectionEnd = s;
        } catch (_) {}
      } else if (s > 0) {
        t.value = t.value.slice(0, s - 1) + t.value.slice(s);
        try {
          t.selectionStart = t.selectionEnd = s - 1;
        } catch (_) {}
      }
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function fire(k, keyEl) {
      var t = ta();
      if (keyEl) {
        keyEl.classList.add("kb-press");
        setTimeout(function () {
          keyEl.classList.remove("kb-press");
        }, 130);
      }
      if (k === "shift") {
        setShift(!shifted);
        return;
      }
      if (k === "close") {
        if (t) t.blur();
        hide();
        return;
      }
      if (!t) return;
      t.focus();
      if (k === "backspace") return back(t);
      if (k === "space") return insert(t, " ");
      if (k === "return") {
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        return;
      }
      insert(t, shifted ? k.toUpperCase() : k);
      if (shifted) setShift(false); // one-shot caps
    }
    function clearHovers() {
      if (!el) return;
      var hs = el.querySelectorAll(".kb-hover");
      for (var i = 0; i < hs.length; i++) hs[i].classList.remove("kb-hover");
    }
    function keyAt(x, y) {
      var e = document.elementFromPoint(x, y);
      var k = e && e.closest ? e.closest(".vkb-key") : null;
      if (k) return k;
      if (!el) return null; // magnetic snap to the nearest key
      var keys = el.querySelectorAll(".vkb-key"),
        best = null,
        bd = 46 * 46;
      for (var i = 0; i < keys.length; i++) {
        var b = keys[i].getBoundingClientRect();
        var nx = Math.max(b.left, Math.min(x, b.right)),
          ny = Math.max(b.top, Math.min(y, b.bottom));
        var dx = x - nx,
          dy = y - ny,
          d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = keys[i];
        }
      }
      return best;
    }
    function frame(hands) {
      if (!isOpenFlag) return;
      clearHovers();
      for (var i = 0; i < 2; i++) {
        var h = hands[i],
          t = tips[i];
        if (!h) {
          if (t) t.style.opacity = 0;
          hoverKey[i] = null;
          continue;
        }
        if (t) {
          t.style.transform = "translate(" + h.x + "px," + h.y + "px)";
          t.style.opacity = 1;
        }
        var k = keyAt(h.x, h.y);
        hoverKey[i] = k;
        if (k) k.classList.add("kb-hover");
      }
    }
    function press(i) {
      var k = hoverKey[i];
      if (k) fire(k.dataset.key, k);
    }
    function pokeTip(i, on) {
      var t = tips[i];
      if (t) t.classList.toggle("poke", !!on);
    }
    function wrap() {
      var box = document.getElementById("mailterm");
      return box && box.closest ? box.closest(".compose-wrap") : null;
    }
    function show() {
      build();
      isOpenFlag = true;
      el.classList.add("open");
      if (scrim) scrim.classList.add("open");
      // float the compose box up so it stays visible above the keyboard
      var w = wrap();
      if (w) w.classList.add("kb-floating");
    }
    function hide() {
      if (!el) return;
      isOpenFlag = false;
      el.classList.remove("open");
      if (scrim) scrim.classList.remove("open");
      var w = wrap();
      if (w) w.classList.remove("kb-floating");
      clearHovers();
      hoverKey = [null, null];
      tips.forEach(function (t) {
        if (t) t.style.opacity = 0;
      });
    }
    return {
      build: build,
      show: show,
      hide: hide,
      isOpen: function () {
        return isOpenFlag;
      },
      frame: frame,
      press: press,
      pokeTip: pokeTip,
    };
  })();

  // In gesture mode, focusing the compose box raises the keyboard.
  (function () {
    var mi = document.getElementById("mail-input");
    if (!mi) return;
    mi.addEventListener("focus", function () {
      if (activeMode === "gesture") Keyboard.show();
    });
    mi.addEventListener("blur", function () {
      Keyboard.hide();
    });
  })();

  window.__ctrl = {
    clamp01: clamp01,
    dist: gDist,
    mapCursor: gMapCursor,
    pinchRatio: gPinchRatio,
    scrollDelta: gScrollDelta,
    dragScroll: gDragScroll,
    forwardSignal: gForwardSignal,
    clickAt: clickAt,
    keyboard: Keyboard,
    G: G,
    KB: KB,
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
        numHands: 2,
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
      pinchStartT = 0,
      lastDragCy = 0, // fingertip Y last frame, for the grab-drag delta
      dragMoved = 0, // total travel this pinch (click vs scroll)
      flingVel = 0, // last frame's scroll amount, seeds the release fling
      clickX = 0,
      clickY = 0, // cursor aim captured at pinch-start
      hasScrolled = false, // did this pinch move the page? (then it's not a click)
      scrollCurVel = 0, // momentum glide after release, applied every render frame
      lastClickT = 0;

    /* ---- keyboard mode: two hands point + poke to type ---- */
    function newSlot() {
      return {
        haveAim: false,
        aimX: 0,
        aimY: 0,
        euro: makeOneEuro(1.0, 0.007, 1.0),
        baseline: null,
        prevS: null,
        prevT: null,
        fsm: "idle",
        lastFireT: 0,
        pinch: false,
      };
    }
    var slot = [newSlot(), newSlot()];
    function resetSlot(k) {
      slot[k] = newSlot();
      Keyboard.pokeTip(k, false);
    }

    // returns true on the frame a deliberate forward poke fires
    function detectPoke(k, Lnorm, Wworld, tMs) {
      var st = slot[k];
      var raw = gForwardSignal(Lnorm, Wworld);
      var s = st.euro(raw, tMs);
      var C = Wworld ? KB.world : KB.norm;
      var dt = st.prevT == null ? 1 / 30 : (tMs - st.prevT) / 1000;
      if (dt <= 0) dt = 1 / 30;
      var vel = st.prevS == null ? 0 : (s - st.prevS) / dt;
      st.prevS = s;
      st.prevT = tMs;
      if (st.baseline == null) st.baseline = s;
      var fired = false;
      if (st.fsm === "idle") {
        st.baseline += KB.BASELINE_EMA * (s - st.baseline); // track drift only while idle
        if (s - st.baseline >= C.FIRE_DISP && vel >= C.FIRE_VEL) {
          fired = true;
          st.fsm = "refractory";
          st.lastFireT = tMs;
        }
      } else if (tMs - st.lastFireT >= KB.REFRACTORY_MS && s - st.baseline <= C.RELEASE_DISP) {
        st.fsm = "idle"; // require the finger to retract before the next tap
      }
      Keyboard.pokeTip(k, s - st.baseline > C.FIRE_DISP * 0.5);
      return fired;
    }

    function handleKeyboardHands(res, W, H) {
      pinching = false; // the keyboard owns the hands; no scroll/click here
      scrollCurVel = 0;
      var tMs = performance.now();
      var hands = [null, null],
        fires = [false, false],
        seen = [false, false];
      var slots = assignSlots(res);
      for (var s = 0; s < slots.length; s++) {
        var idx = slots[s].i,
          k = slots[s].slot;
        seen[k] = true;
        var Ln = res.landmarks[idx];
        var Wn = res.worldLandmarks && res.worldLandmarks[idx] ? res.worldLandmarks[idx] : null;
        var st = slot[k];
        var tip = gMapCursor(Ln[8], W, H, KB.GAIN);
        if (!st.haveAim) {
          st.aimX = tip.x;
          st.aimY = tip.y;
          st.haveAim = true;
        } else {
          st.aimX += KB.SMOOTH * (tip.x - st.aimX);
          st.aimY += KB.SMOOTH * (tip.y - st.aimY);
        }
        hands[k] = { x: st.aimX, y: st.aimY };
        var ratio = gPinchRatio(Ln); // pinch = reliable fallback press
        if (!st.pinch && ratio < G.PINCH_ON) {
          st.pinch = true;
          fires[k] = true;
        } else if (st.pinch && ratio > G.PINCH_OFF) {
          st.pinch = false;
        }
        if (detectPoke(k, Ln, Wn, tMs)) fires[k] = true;
      }
      for (var m = 0; m < 2; m++) if (!seen[m]) resetSlot(m);
      Keyboard.frame(hands);
      for (var f = 0; f < 2; f++) if (fires[f]) Keyboard.press(f);
    }

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

      if (!pinching && ratio < G.PINCH_ON) {
        // pinch begins — grab the page here
        pinching = true;
        pinchStartT = now;
        lastDragCy = cy;
        dragMoved = 0;
        flingVel = 0;
        clickX = cx;
        clickY = cy;
        hasScrolled = false;
        scrollCurVel = 0; // cancel any leftover momentum
      } else if (pinching && ratio > G.PINCH_OFF) {
        // release. Never moved → it's a CLICK. Moved with speed → fling.
        if (!hasScrolled && now - lastClickT > G.CLICK_DEBOUNCE_MS) {
          clickAt(clickX, clickY);
          lastClickT = now;
        } else if (Math.abs(flingVel) > G.FLING_MIN) {
          scrollCurVel = flingVel * G.MOMENTUM_SEED;
        }
        pinching = false;
      }

      if (pinching) {
        if (now - pinchStartT < G.SCROLL_GRACE_MS) {
          // Settle window: the fingertip drifts as the pinch closes. Keep the
          // grab point and click aim glued so settle doesn't scroll and a quick
          // tap stays a clean click.
          lastDragCy = cy;
          clickX = cx;
          clickY = cy;
          flingVel = 0;
          setStatus("pinch · release to click, move to scroll · esc to exit", true);
        } else {
          // Grab-drag: the page follows the hand the instant it moves.
          var dy = cy - lastDragCy;
          lastDragCy = cy;
          dragMoved += Math.abs(dy);
          if (Math.abs(dy) > 0.05) {
            var amt = gDragScroll(dy);
            window.scrollBy(0, amt);
            flingVel = amt;
            if (dragMoved > G.CLICK_MOVE_TOL) hasScrolled = true;
          } else {
            flingVel *= 0.6; // hand held still → don't fling on release
          }
          setStatus(
            hasScrolled
              ? "scrolling · release to stop · esc to exit"
              : "move to scroll · release to click · esc to exit",
            true
          );
        }
      } else {
        setStatus("move your hand · pinch to click · pinch + move to scroll · esc to exit", true);
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
          var haveHands = res && res.landmarks && res.landmarks.length;
          lastLandmarks = haveHands ? res.landmarks[0] : null;
          if (Keyboard.isOpen()) {
            if (haveHands) handleKeyboardHands(res, W, H);
            else {
              Keyboard.frame([null, null]);
              resetSlot(0);
              resetSlot(1);
              setStatus("point at the keys · poke or pinch to type · esc to exit", true);
            }
          } else if (lastLandmarks) {
            processHand(lastLandmarks, W, H);
          } else {
            if (pinching) pinching = false;
            setStatus("show me your hand ✋", true);
          }
        }
      }

      // The grab-drag scrolls directly while pinched (in processHand). Between
      // pinches, glide the leftover fling momentum to a smooth stop at 60fps.
      if (!pinching && Math.abs(scrollCurVel) > 0.3) {
        window.scrollBy(0, scrollCurVel);
        scrollCurVel *= G.FRICTION;
      } else if (!pinching) {
        scrollCurVel = 0;
      }

      // Skeleton only in cursor mode; the keyboard shows its own fingertip dots.
      if (!Keyboard.isOpen() && lastLandmarks) drawSkeleton(lastLandmarks, W, H);
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

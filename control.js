/* paper & ink — hand-typing, an opt-in party trick.
   The whole site is driven normally with a mouse / trackpad. When you focus
   the compose box it offers, just for fun, to let you type by pointing your
   two index fingers at an on-screen glass keyboard and poking (or pinching)
   to press a key. The camera runs only during a session and entirely in the
   browser via a pre-trained MediaPipe model — no video ever leaves the device. */
(function () {
  "use strict";

  var hud = document.getElementById("control-hud");
  var hudCam = document.getElementById("hud-cam");
  var hudStatus = document.getElementById("hud-status");
  var hudExit = document.getElementById("hud-exit");
  var mailInput = document.getElementById("mail-input");
  if (!mailInput || !hud || !hudCam) return;

  var handMode = false; // is a hand-typing session running?
  var starting = false;
  var stopFns = [];
  var camStream = null;
  var handLandmarker = null;
  var rafId = 0;
  var lastVideoTime = -1;

  /* ------------------------------ helpers ------------------------------- */
  function setStatus(text, live) {
    if (!hudStatus) return;
    hudStatus.textContent = text;
    hudStatus.classList.toggle("live", !!live);
  }

  // Resolves once hudCam is playing the webcam.
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

  /* ===================== poke-typing config =====================
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
  var G = { PINCH_ON: 0.45, PINCH_OFF: 0.62 }; // pinch = thumb→index over finger length

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function gDist(a, b) {
    var dx = a.x - b.x,
      dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function gMapCursor(lm8, W, H, gain) {
    var mx = 1 - lm8.x,
      my = lm8.y; // mirror X (selfie)
    return {
      x: clamp01(0.5 + (mx - 0.5) * gain) * W,
      y: clamp01(0.5 + (my - 0.5) * gain) * H,
    };
  }
  function gPinchRatio(lms) {
    return gDist(lms[4], lms[8]) / (gDist(lms[5], lms[8]) || 1e-6);
  }

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
      var hint = document.createElement("div");
      hint.className = "vkb-hint";
      hint.textContent = "point at a key, then pinch 👌 to press";
      el.appendChild(hint);
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
        onClose(); // ends the whole hand-typing session
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
    var onClose = function () {};
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
      setOnClose: function (fn) {
        onClose = fn;
      },
    };
  })();

  /* ---- per-hand poke state ---- */
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

  function loop() {
    if (!handMode) return;
    rafId = requestAnimationFrame(loop);
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
        var W = window.innerWidth,
          H = window.innerHeight;
        if (res && res.landmarks && res.landmarks.length) {
          handleKeyboardHands(res, W, H);
        } else {
          Keyboard.frame([null, null]);
          resetSlot(0);
          resetSlot(1);
          setStatus("point at a key · pinch 👌 to press (or poke) · esc to stop", true);
        }
      }
    }
  }

  /* ---------------------- session start / stop ---------------------- */
  async function startHandTyping() {
    if (handMode || starting) return;
    starting = true;
    hidePrompt();
    try {
      await ensureCamera();
    } catch (_) {
      setStatus("camera blocked — just type normally", false);
      setTimeout(function () {
        hud.hidden = true;
      }, 1800);
      starting = false;
      return;
    }
    setStatus("loading the hand model…", false);
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
      setStatus("couldn't load the hand model — just type normally", false);
      setTimeout(function () {
        hud.hidden = true;
      }, 1800);
      starting = false;
      return;
    }
    starting = false;
    handMode = true;
    stopFns.push(function () {
      try {
        handLandmarker.close();
      } catch (_) {}
      handLandmarker = null;
    });
    resetSlot(0);
    resetSlot(1);
    mailInput.focus();
    Keyboard.show();
    setStatus("point at a key · pinch 👌 to press (or poke) · esc to stop", true);
    lastVideoTime = -1;
    rafId = requestAnimationFrame(loop);
    stopFns.push(function () {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    });
  }

  function stopHandTyping() {
    if (!handMode && !starting) {
      Keyboard.hide();
      hud.hidden = true;
      return;
    }
    handMode = false;
    starting = false;
    Keyboard.hide();
    stopFns.forEach(function (fn) {
      try {
        fn();
      } catch (_) {}
    });
    stopFns = [];
    hud.hidden = true;
  }

  Keyboard.setOnClose(function () {
    var t = document.getElementById("mail-input");
    if (t) t.blur();
    stopHandTyping();
  });

  /* ---------------------- the "try it" prompt ---------------------- */
  var promptEl = null,
    dismissed = false;
  function buildPrompt() {
    if (promptEl) return;
    var w = mailInput.closest(".compose-wrap");
    if (!w) return;
    promptEl = document.createElement("div");
    promptEl.className = "hand-cta";
    var tryBtn = document.createElement("button");
    tryBtn.type = "button";
    tryBtn.className = "hand-cta-try";
    tryBtn.textContent = "✋ type with your hand gestures";
    var sub = document.createElement("span");
    sub.className = "hand-cta-sub";
    sub.textContent = "just for fun";
    var x = document.createElement("button");
    x.type = "button";
    x.className = "hand-cta-x";
    x.setAttribute("aria-label", "no thanks");
    x.textContent = "×";
    promptEl.appendChild(tryBtn);
    promptEl.appendChild(sub);
    promptEl.appendChild(x);
    promptEl.addEventListener("mousedown", function (e) {
      e.preventDefault(); // keep focus in the textarea
    });
    tryBtn.addEventListener("click", startHandTyping);
    x.addEventListener("click", function () {
      dismissed = true;
      hidePrompt();
    });
    w.appendChild(promptEl);
  }
  function showPrompt() {
    if (dismissed || handMode || starting) return;
    buildPrompt();
    if (promptEl) promptEl.classList.add("show");
  }
  function hidePrompt() {
    if (promptEl) promptEl.classList.remove("show");
  }

  mailInput.addEventListener("focus", function () {
    if (!handMode) showPrompt();
  });
  mailInput.addEventListener("blur", function () {
    hidePrompt();
    if (handMode) stopHandTyping();
  });

  if (hudExit) {
    hudExit.textContent = "stop";
    hudExit.addEventListener("click", stopHandTyping);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (handMode || starting)) stopHandTyping();
  });

  window.__ctrl = {
    mapCursor: gMapCursor,
    pinchRatio: gPinchRatio,
    forwardSignal: gForwardSignal,
    keyboard: Keyboard,
    startHandTyping: startHandTyping,
    stopHandTyping: stopHandTyping,
    G: G,
    KB: KB,
  };
})();

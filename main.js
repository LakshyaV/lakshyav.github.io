/* paper & ink — the small amount of JavaScript this page needs.
   Three jobs: remember the intro, run the toys, draw your signal. */

(function () {
  "use strict";

  /* ------------------------- intro plays once ------------------------- */
  try {
    sessionStorage.setItem("intro-done", "1");
  } catch (_) {}

  /* ----------------------------- ink dock ----------------------------- */
  var root = document.documentElement;
  var drops = document.querySelectorAll(".ink-drop");

  function markActive() {
    var current = root.getAttribute("data-ink") || "black";
    drops.forEach(function (d) {
      d.classList.toggle("active", d.dataset.ink === current);
    });
  }

  drops.forEach(function (drop) {
    drop.addEventListener("click", function () {
      root.setAttribute("data-ink", drop.dataset.ink);
      try {
        localStorage.setItem("ink", drop.dataset.ink);
      } catch (_) {}
      markActive();
    });
  });
  markActive();

  /* ---------------------------- paper toggle --------------------------- */
  var toggle = document.getElementById("paper-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var dark = root.getAttribute("data-paper") === "dark";
      if (dark) root.removeAttribute("data-paper");
      else root.setAttribute("data-paper", "dark");
      try {
        localStorage.setItem("paper", dark ? "light" : "dark");
      } catch (_) {}
    });
  }

  /* ------------------------- doodles draw in --------------------------- */
  var doodles = document.querySelectorAll(".doodle");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("drawn");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    doodles.forEach(function (d) {
      io.observe(d);
    });
  } else {
    doodles.forEach(function (d) {
      d.classList.add("drawn");
    });
  }

  /* ------------------------------ your signal --------------------------
     The pill listens to the visitor. Pointer velocity and scroll delta
     become the amplitude of a live trace; idle is a quiet breathing line.
     The page reading you, politely. */
  var canvas = document.getElementById("signal-canvas");
  if (!canvas || !canvas.getContext) return;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ctx = canvas.getContext("2d");

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var W = 150;
  var H = 34;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  var samples = new Array(W).fill(0);
  var energy = 0;
  var lastX = null;
  var lastY = null;
  var lastScroll = window.scrollY;
  var t = 0;

  window.addEventListener(
    "pointermove",
    function (e) {
      if (lastX !== null) {
        var d = Math.hypot(e.clientX - lastX, e.clientY - lastY);
        energy = Math.min(1, energy + d / 260);
      }
      lastX = e.clientX;
      lastY = e.clientY;
    },
    { passive: true }
  );

  window.addEventListener(
    "scroll",
    function () {
      var d = Math.abs(window.scrollY - lastScroll);
      lastScroll = window.scrollY;
      energy = Math.min(1, energy + d / 900);
    },
    { passive: true }
  );

  function inkColor() {
    return getComputedStyle(root).getPropertyValue("--ink-accent").trim() || "#26201a";
  }

  var color = inkColor();
  new MutationObserver(function () {
    color = inkColor();
  }).observe(root, { attributes: true, attributeFilter: ["data-ink", "data-paper"] });

  function frame() {
    requestAnimationFrame(frame);
    t += 1;

    energy *= 0.94; // decay back toward calm

    // quiet breathing baseline + energy-driven pulse
    var breath = Math.sin(t * 0.045) * 0.08;
    var pulse =
      (Math.sin(t * 0.6) * 0.5 + Math.sin(t * 1.3 + 1.2) * 0.35 + Math.sin(t * 2.2) * 0.15) *
      energy;
    var noise = (Math.random() - 0.5) * 0.05;
    samples.push(breath + pulse + noise);
    samples.shift();

    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    for (var i = 0; i < W; i++) {
      var y = H / 2 - samples[i] * (H / 2 - 3);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  if (reduced) {
    // one calm, still line — the page does not move for you
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  } else {
    requestAnimationFrame(frame);
  }
})();

/* paper & ink — island player, palette dock, doodles, contribution graph,
   and the signal that never stops listening. */

(function () {
  "use strict";

  try {
    sessionStorage.setItem("intro-done", "1");
  } catch (_) {}

  var root = document.documentElement;

  /* ============================ palette dock ============================ */
  var chips = document.querySelectorAll(".chip");

  function markChip() {
    var current = root.getAttribute("data-theme") || "paper";
    chips.forEach(function (c) {
      c.classList.toggle("active", c.dataset.theme === current);
    });
  }
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      root.setAttribute("data-theme", chip.dataset.theme);
      try {
        localStorage.setItem("theme", chip.dataset.theme);
      } catch (_) {}
      markChip();
    });
  });
  markChip();

  var paperToggle = document.getElementById("paper-toggle");
  if (paperToggle) {
    paperToggle.addEventListener("click", function () {
      var dark = root.getAttribute("data-paper") === "dark";
      if (dark) root.removeAttribute("data-paper");
      else root.setAttribute("data-paper", "dark");
      try {
        localStorage.setItem("paper", dark ? "light" : "dark");
      } catch (_) {}
    });
  }

  /* ============================== doodles =============================== */
  var doodles = document.querySelectorAll(".doodle");
  if ("IntersectionObserver" in window) {
    var dio = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("drawn");
            dio.unobserve(e.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    doodles.forEach(function (d) {
      dio.observe(d);
    });
  } else {
    doodles.forEach(function (d) {
      d.classList.add("drawn");
    });
  }

  /* ============================== side nav =============================== */
  var dots = document.querySelectorAll(".sd");
  var sections = ["home", "work", "github", "contact"]
    .map(function (id) {
      return document.getElementById(id);
    })
    .filter(Boolean);

  if ("IntersectionObserver" in window && sections.length) {
    var visible = new Set();
    var nio = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        });
        var current = null;
        sections.forEach(function (s) {
          if (visible.has(s.id)) current = s.id;
        });
        dots.forEach(function (d) {
          d.classList.toggle("active", d.dataset.target === current);
        });
      },
      { rootMargin: "-30% 0px -55% 0px" }
    );
    sections.forEach(function (s) {
      nio.observe(s);
    });
  }

  /* ========================= contribution graph =========================
     Real contributions, drawn in the site's own accent so every palette
     recolours the year. Falls back to a friendly line if the API is out. */
  var graph = document.getElementById("gh-graph");
  var totalEl = document.getElementById("gh-total");
  var fallback = document.getElementById("gh-fallback");

  fetch("https://github-contributions-api.jogruber.de/v4/LakshyaV?y=last")
    .then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (data) {
      var days = data.contributions || [];
      if (!days.length) throw new Error("empty");

      var grid = document.createElement("div");
      grid.className = "gh-grid";
      var week = null;
      days.forEach(function (day, i) {
        if (i % 7 === 0) {
          week = document.createElement("div");
          week.className = "gh-week";
          grid.appendChild(week);
        }
        var cell = document.createElement("span");
        cell.className = "gh-day";
        cell.setAttribute("data-level", String(day.level));
        cell.title = day.date + " · " + day.count + (day.count === 1 ? " contribution" : " contributions");
        week.appendChild(cell);
      });

      if (fallback) fallback.remove();
      graph.appendChild(grid);
      graph.scrollLeft = graph.scrollWidth; // land on the most recent weeks

      var total = data.total && (data.total.lastYear || data.total[new Date().getFullYear()]);
      if (totalEl && total) {
        totalEl.textContent = total + " contributions in the last year";
      } else if (totalEl) {
        totalEl.textContent = "a year of pushes, drawn below";
      }
    })
    .catch(function () {
      if (totalEl) totalEl.textContent = "github is being shy right now";
      if (fallback) fallback.textContent = "the graph would go here. see the real one on github ↗";
    });

  /* ============================ dynamic island ===========================
     Compact, it draws your signal. Open, it plays music. Swap TRACKS for
     your own files or hosted mp3s; art is generated so nothing is owed. */
  var TRACKS = [
    { title: "song one", artist: "soundhelix, placeholder", src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", hue: 28 },
    { title: "song four", artist: "soundhelix, placeholder", src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3", hue: 208 },
    { title: "song eight", artist: "soundhelix, placeholder", src: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3", hue: 130 },
  ];

  var island = document.getElementById("island");
  var compact = document.getElementById("island-compact");
  var audio = document.getElementById("audio");
  var btnPlay = document.getElementById("btn-play");
  var btnPrev = document.getElementById("btn-prev");
  var btnNext = document.getElementById("btn-next");
  var iconPlay = document.getElementById("icon-play");
  var iconPause = document.getElementById("icon-pause");
  var seek = document.getElementById("seek");
  var curTime = document.getElementById("cur-time");
  var durTime = document.getElementById("dur-time");
  var titleEl = document.getElementById("track-title");
  var artistEl = document.getElementById("track-artist");
  var artCanvas = document.getElementById("art-canvas");
  var viz = document.getElementById("viz");

  var trackIndex = 0;
  var seeking = false;

  // visualizer bars
  var BAR_COUNT = 14;
  for (var i = 0; i < BAR_COUNT; i++) viz.appendChild(document.createElement("i"));
  var bars = viz.children;

  function fmt(s) {
    if (!isFinite(s)) return "0:00";
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function drawArt(hue) {
    var c = artCanvas.getContext("2d");
    var g = c.createLinearGradient(0, 0, 96, 96);
    g.addColorStop(0, "hsl(" + hue + ", 62%, 62%)");
    g.addColorStop(1, "hsl(" + ((hue + 50) % 360) + ", 55%, 38%)");
    c.fillStyle = g;
    c.fillRect(0, 0, 96, 96);
    c.strokeStyle = "rgba(255,255,255,0.85)";
    c.lineWidth = 2;
    c.lineCap = "round";
    c.beginPath();
    for (var x = 10; x <= 86; x += 2) {
      var y = 48 - Math.sin((x - 10) / 9) * 14 * Math.sin((x - 10) / 26);
      if (x === 10) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }

  function loadTrack(index, andPlay) {
    trackIndex = (index + TRACKS.length) % TRACKS.length;
    var t = TRACKS[trackIndex];
    audio.src = t.src;
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist;
    drawArt(t.hue);
    [titleEl.parentElement, artistEl.parentElement].forEach(function (m) {
      m.classList.toggle("scrolling", m.firstElementChild.scrollWidth > m.clientWidth);
    });
    if (andPlay) audio.play().catch(function () {});
  }

  function setPlayingUI(playing) {
    island.classList.toggle("playing", playing);
    iconPlay.style.display = playing ? "none" : "";
    iconPause.style.display = playing ? "" : "none";
    btnPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  compact.addEventListener("click", function () {
    island.classList.toggle("open");
  });
  document.addEventListener("click", function (e) {
    if (island.classList.contains("open") && !island.contains(e.target)) {
      island.classList.remove("open");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") island.classList.remove("open");
  });

  btnPlay.addEventListener("click", function () {
    if (!audio.src) loadTrack(0, false);
    if (audio.paused) audio.play().catch(function () {});
    else audio.pause();
  });
  btnPrev.addEventListener("click", function () {
    loadTrack(trackIndex - 1, !audio.paused || !audio.src);
  });
  btnNext.addEventListener("click", function () {
    loadTrack(trackIndex + 1, !audio.paused || !audio.src);
  });

  audio.addEventListener("play", function () {
    setPlayingUI(true);
    ensureAnalyser();
  });
  audio.addEventListener("pause", function () {
    setPlayingUI(false);
  });
  audio.addEventListener("ended", function () {
    loadTrack(trackIndex + 1, true);
  });
  audio.addEventListener("timeupdate", function () {
    if (!seeking && audio.duration) seek.value = String((audio.currentTime / audio.duration) * 1000);
    curTime.textContent = fmt(audio.currentTime);
    durTime.textContent = fmt(audio.duration);
  });
  seek.addEventListener("input", function () {
    seeking = true;
  });
  seek.addEventListener("change", function () {
    if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    seeking = false;
  });

  drawArt(TRACKS[0].hue);

  /* --- visualizer: real spectrum if CORS allows, synthetic otherwise --- */
  var analyser = null;
  var freq = null;
  var analyserDead = false;

  function ensureAnalyser() {
    if (analyser || analyserDead) return;
    // Chrome mutes cross-origin media routed through WebAudio without CORS,
    // so only wire the analyser for same-origin tracks. Remote placeholders
    // get the synthetic bars.
    try {
      if (new URL(audio.src, location.href).origin !== location.origin) {
        analyserDead = true;
        return;
      }
    } catch (_) {
      analyserDead = true;
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx2 = new AC();
      var srcNode = ctx2.createMediaElementSource(audio);
      analyser = ctx2.createAnalyser();
      analyser.fftSize = 64;
      srcNode.connect(analyser);
      analyser.connect(ctx2.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch (_) {
      analyserDead = true;
    }
  }

  var zeroFrames = 0;
  function vizFrame(t) {
    var playing = !audio.paused && audio.src;
    var level;
    if (playing && analyser && !analyserDead) {
      analyser.getByteFrequencyData(freq);
      var sum = 0;
      for (var i = 0; i < freq.length; i++) sum += freq[i];
      if (sum === 0) {
        zeroFrames += 1;
        if (zeroFrames > 90) analyserDead = true; // CORS-tainted, fall back
      } else zeroFrames = 0;
    }
    for (var b = 0; b < BAR_COUNT; b++) {
      if (playing && analyser && !analyserDead && zeroFrames === 0) {
        level = freq[Math.floor((b / BAR_COUNT) * freq.length)] / 255;
      } else if (playing) {
        level = 0.25 + 0.75 * Math.abs(Math.sin(t / 260 + b * 0.9) * Math.sin(t / 730 + b));
      } else {
        level = 0.08;
      }
      bars[b].style.height = Math.max(2, level * 12) + "px";
    }
  }

  /* ------------------------------ your signal --------------------------- */
  var canvas = document.getElementById("signal-canvas");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var sctx = canvas.getContext("2d");
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var W = 132;
  var H = 26;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  sctx.scale(dpr, dpr);

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
        energy = Math.min(1, energy + Math.hypot(e.clientX - lastX, e.clientY - lastY) / 260);
      }
      lastX = e.clientX;
      lastY = e.clientY;
    },
    { passive: true }
  );
  window.addEventListener(
    "scroll",
    function () {
      energy = Math.min(1, energy + Math.abs(window.scrollY - lastScroll) / 900);
      lastScroll = window.scrollY;
    },
    { passive: true }
  );

  function frame(ts) {
    requestAnimationFrame(frame);
    t += 1;
    energy *= 0.94;

    var breath = Math.sin(t * 0.045) * 0.1;
    var pulse =
      (Math.sin(t * 0.6) * 0.5 + Math.sin(t * 1.3 + 1.2) * 0.35 + Math.sin(t * 2.2) * 0.15) * energy;
    samples.push(breath + pulse + (Math.random() - 0.5) * 0.06);
    samples.shift();

    sctx.clearRect(0, 0, W, H);
    sctx.beginPath();
    for (var i = 0; i < W; i++) {
      var y = H / 2 - samples[i] * (H / 2 - 2);
      if (i === 0) sctx.moveTo(i, y);
      else sctx.lineTo(i, y);
    }
    sctx.strokeStyle = "rgba(243, 234, 217, 0.95)";
    sctx.lineWidth = 1.3;
    sctx.stroke();

    vizFrame(ts || t * 16);
  }

  if (reduced) {
    sctx.beginPath();
    sctx.moveTo(0, H / 2);
    sctx.lineTo(W, H / 2);
    sctx.strokeStyle = "rgba(243, 234, 217, 0.7)";
    sctx.lineWidth = 1.3;
    sctx.stroke();
  } else {
    requestAnimationFrame(frame);
  }
})();

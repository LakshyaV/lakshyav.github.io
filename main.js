/* paper & ink — island player, palette dock, contribution graph,
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
     The last 30 days as GitHub's classic green squares in one full-width row.
     A tiny hand-drawn face sits inline beside the count as a quiet easter
     egg: hover a deep-green day and it grins, a grey one and it turns grumpy.
     The face morphs continuously toward a target "mood", so it never snaps. */
  var graph = document.getElementById("gh-graph");
  var totalEl = document.getElementById("gh-total");
  var streakEl = document.getElementById("gh-streak");
  var statsEl = document.getElementById("gh-stats");
  var fallback = document.getElementById("gh-fallback");

  function fmtDate(d) {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  /* ------------------------------- the face ----------------------------- */
  var faceReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fEl = {
    mouth: document.getElementById("mouth"),
    eyeL: document.getElementById("eyeL"),
    eyeR: document.getElementById("eyeR"),
    browL: document.getElementById("browL"),
    browR: document.getElementById("browR"),
    blushL: document.getElementById("blushL"),
    blushR: document.getElementById("blushR"),
  };
  var moodCur = 0.5,
    moodTarget = 0.5,
    defaultMood = 0.5,
    fN = 0,
    blinkUntil = 0,
    nextBlink = 130;

  // Draw the face for a mood in [0 = grumpy, 1 = delighted].
  function drawFace(m, blink) {
    if (!fEl.mouth) return;
    var eyeRx = 5 + m * 2.4; // wider eyes when excited
    var eyeRy = blink ? 1 : eyeRx;
    fEl.eyeL.setAttribute("rx", eyeRx.toFixed(1));
    fEl.eyeL.setAttribute("ry", eyeRy.toFixed(1));
    fEl.eyeR.setAttribute("rx", eyeRx.toFixed(1));
    fEl.eyeR.setAttribute("ry", eyeRy.toFixed(1));
    // mouth: control point above the corners = frown, below = smile
    var cy = 78 + (m * 2 - 1) * 17;
    fEl.mouth.setAttribute("d", "M42 78 Q60 " + cy.toFixed(1) + " 78 78");
    // brows: inner ends drop toward the nose when grumpy, lift when happy
    var oy = 42 - m * 3;
    var iy = 42 + (1 - m) * 8 - m * 4;
    fEl.browL.setAttribute("d", "M32 " + oy.toFixed(1) + " L48 " + iy.toFixed(1));
    fEl.browR.setAttribute("d", "M88 " + oy.toFixed(1) + " L72 " + iy.toFixed(1));
    // blush fades in only when it's really pleased
    var bl = (Math.max(0, m - 0.62) / 0.38) * 0.85;
    fEl.blushL.setAttribute("opacity", bl.toFixed(2));
    fEl.blushR.setAttribute("opacity", bl.toFixed(2));
  }

  function faceLoop() {
    requestAnimationFrame(faceLoop);
    fN += 1;
    moodCur += (moodTarget - moodCur) * 0.16;
    var blink = false;
    if (!faceReduced) {
      if (fN >= nextBlink) {
        blinkUntil = fN + 7;
        nextBlink = fN + 150;
      }
      blink = fN < blinkUntil;
    }
    drawFace(moodCur, blink);
  }
  if (fEl.mouth) {
    drawFace(0.5, false);
    requestAnimationFrame(faceLoop);
  }

  fetch("https://github-contributions-api.jogruber.de/v4/LakshyaV?y=last")
    .then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (data) {
      var all = data.contributions || [];
      if (!all.length) throw new Error("empty");

      var todayStr = new Date().toDateString();
      var recent = all.slice(-30);

      var monthTotal = recent.reduce(function (n, d) { return n + d.count; }, 0);
      var maxCount = recent.reduce(function (m, d) { return Math.max(m, d.count); }, 0) || 1;
      var activeDays = recent.filter(function (d) { return d.count > 0; }).length;
      var avg = Math.round((monthTotal / recent.length) * 10) / 10;
      var meanLevel = recent.reduce(function (s, d) { return s + d.level; }, 0) / recent.length;

      var streak = 0;
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].count > 0) streak++;
        else if (i === all.length - 1) continue;
        else break;
      }

      // classic green squares, one flat row of 30 that stretches to fill the card
      if (fallback) fallback.remove();
      recent.forEach(function (day) {
        var sq = document.createElement("span");
        sq.className = "gh-sq";
        sq.setAttribute("data-level", String(day.level));
        if (new Date(day.date + "T00:00:00").toDateString() === todayStr) sq.classList.add("today");
        sq.title = fmtDate(day.date) + " · " + day.count + (day.count === 1 ? " contribution" : " contributions");
        // hovering a square pulls the face toward that day's mood
        sq.addEventListener("mouseenter", function () {
          moodTarget = day.level / 4;
        });
        graph.appendChild(sq);
      });

      // resting expression is content by default (a soft smile), leaning
      // happier in a busy month; hovering is what drives it to the extremes
      defaultMood = Math.max(0.58, Math.min(0.9, 0.45 + meanLevel / 3));
      moodTarget = defaultMood;
      graph.addEventListener("mouseleave", function () {
        moodTarget = defaultMood;
      });

      if (totalEl) {
        totalEl.innerHTML =
          "<b>" + monthTotal + "</b> contribution" + (monthTotal === 1 ? "" : "s") + " this month";
      }
      if (streakEl && streak > 1) {
        streakEl.textContent = "🔥 " + streak + "-day streak";
        streakEl.hidden = false;
      }
      if (statsEl) {
        document.getElementById("gh-stat-best").textContent = maxCount;
        document.getElementById("gh-stat-avg").textContent = avg;
        document.getElementById("gh-stat-active").innerHTML = activeDays + "<i>/" + recent.length + "</i>";
        statsEl.hidden = false;
      }
    })
    .catch(function () {
      if (totalEl) totalEl.textContent = "github is being shy right now";
      if (fallback) fallback.textContent = "see the real graph on github ↗";
    });

  /* ============================ dynamic island ===========================
     Compact, it draws your signal and a live status. Hover (or tap) and it
     blooms into a music player. Tracks are hosted in /music, so they are
     same-origin — which is what lets the visualizer read the real audio
     spectrum instead of faking it. To change the playlist, drop mp3s in
     /music and edit this array. Music is royalty-free (soundhelix). */
  var TRACKS = [
    { title: "night shift", artist: "royalty-free · soundhelix", src: "music/track-1.mp3", hue: 212 },
    { title: "signal drift", artist: "royalty-free · soundhelix", src: "music/track-3.mp3", hue: 150 },
    { title: "deep work", artist: "royalty-free · soundhelix", src: "music/track-8.mp3", hue: 30 },
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
  var artWrap = document.querySelector(".island-art");
  var viz = document.getElementById("viz");

  var trackIndex = 0;
  var seeking = false;
  var curHue = TRACKS[0].hue;

  // visualizer bars
  var BAR_COUNT = 18;
  for (var i = 0; i < BAR_COUNT; i++) viz.appendChild(document.createElement("i"));
  var bars = viz.children;

  function fmt(s) {
    if (!isFinite(s)) return "0:00";
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function drawArt(hue) {
    curHue = hue;
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

  // Only marquee text that genuinely overflows. Must be measured while the
  // island is open, or clientWidth is 0 and everything looks like it overflows.
  function updateMarquee() {
    [titleEl.parentElement, artistEl.parentElement].forEach(function (m) {
      var overflow = m.clientWidth > 0 && m.firstElementChild.scrollWidth > m.clientWidth + 4;
      m.classList.toggle("scrolling", overflow);
    });
  }

  function loadTrack(index, andPlay) {
    trackIndex = (index + TRACKS.length) % TRACKS.length;
    var t = TRACKS[trackIndex];
    audio.src = t.src;
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist;
    drawArt(t.hue);
    updateMarquee();
    if (andPlay) audio.play().catch(function () {});
  }

  function setPlayingUI(playing) {
    island.classList.toggle("playing", playing);
    iconPlay.style.display = playing ? "none" : "";
    iconPause.style.display = playing ? "" : "none";
    btnPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  // Desktop opens on hover; touch (no hover) opens on tap. A small close
  // delay keeps it from snapping shut while the pointer crosses a gap.
  var hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var closeTimer = null;
  function openIsland() {
    clearTimeout(closeTimer);
    island.classList.add("open");
    requestAnimationFrame(updateMarquee); // now that widths are real
  }
  function closeSoon() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      island.classList.remove("open");
    }, 260);
  }
  if (hoverCapable) {
    island.addEventListener("mouseenter", openIsland);
    island.addEventListener("mouseleave", closeSoon);
  } else {
    compact.addEventListener("click", function () {
      island.classList.toggle("open");
      if (island.classList.contains("open")) requestAnimationFrame(updateMarquee);
    });
  }
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

  loadTrack(0, false); // show the first track ready, no download until play

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
      if (ctx2.state === "suspended") ctx2.resume();
      var srcNode = ctx2.createMediaElementSource(audio);
      analyser = ctx2.createAnalyser();
      analyser.fftSize = 128;
      srcNode.connect(analyser);
      analyser.connect(ctx2.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch (_) {
      analyserDead = true;
    }
  }

  var zeroFrames = 0;
  var glow = 0;
  function vizFrame(t) {
    var playing = !audio.paused && audio.src;
    var level;
    var real = false;
    if (playing && analyser && !analyserDead) {
      analyser.getByteFrequencyData(freq);
      var sum = 0;
      for (var i = 0; i < freq.length; i++) sum += freq[i];
      if (sum === 0) {
        zeroFrames += 1;
        if (zeroFrames > 90) analyserDead = true; // tainted, fall back
      } else {
        zeroFrames = 0;
        real = true;
      }
    }
    for (var b = 0; b < BAR_COUNT; b++) {
      if (real) {
        // skip the very lowest bins (mostly DC) for a livelier spread
        level = freq[2 + Math.floor((b / BAR_COUNT) * (freq.length - 4))] / 255;
      } else if (playing) {
        level = 0.25 + 0.75 * Math.abs(Math.sin(t / 260 + b * 0.9) * Math.sin(t / 730 + b));
      } else {
        level = 0.08;
      }
      bars[b].style.height = Math.max(2, level * 15) + "px";
    }

    // album art glows and breathes with the low end
    var target = 0;
    if (real) target = (freq[1] + freq[2] + freq[3] + freq[4]) / (4 * 255);
    else if (playing) target = 0.35 + 0.25 * Math.abs(Math.sin(t / 300));
    glow += (target - glow) * 0.2;
    if (artWrap) {
      if (playing) {
        artWrap.style.boxShadow =
          "0 2px 10px rgba(0,0,0,0.4), 0 0 " +
          (8 + glow * 30) +
          "px hsla(" + curHue + ", 72%, 60%, " + (0.28 + glow * 0.5) + ")";
        artWrap.style.transform = "scale(" + (1 + glow * 0.05) + ")";
      } else {
        artWrap.style.boxShadow = "";
        artWrap.style.transform = "";
      }
    }
  }

  /* ==================== live status: clock + github pulse ================
     The island earns its keep even before you play anything: a live clock
     in Ontario next to a real github pulse, so a visitor can see he is
     probably up at 2am shipping. */
  var statLocal = document.getElementById("stat-local");
  var statGh = document.getElementById("stat-gh");

  function relTime(date) {
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function updateClock() {
    if (!statLocal) return;
    try {
      var time = new Date()
        .toLocaleTimeString("en-US", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" })
        .toLowerCase()
        .replace(" ", "");
      statLocal.textContent = "building origin · " + time + " ET";
    } catch (_) {
      statLocal.textContent = "building origin";
    }
  }
  updateClock();
  setInterval(updateClock, 20000);

  fetch("https://api.github.com/users/LakshyaV/events/public?per_page=100")
    .then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (events) {
      var pushes = events.filter(function (e) {
        return e.type === "PushEvent";
      });
      var todayStr = new Date().toDateString();
      var commitsToday = pushes.reduce(function (n, e) {
        if (new Date(e.created_at).toDateString() !== todayStr) return n;
        return n + (e.payload && e.payload.commits ? e.payload.commits.length : 0);
      }, 0);
      if (statGh) {
        statGh.textContent = pushes.length
          ? "pushed " + relTime(new Date(pushes[0].created_at)) + (commitsToday ? " · " + commitsToday + " today" : "")
          : "github ↗";
      }
      var footnote = document.querySelector(".gh-footnote");
      if (footnote && commitsToday > 0) {
        footnote.textContent = footnote.textContent + " · " + commitsToday + " today";
      }
    })
    .catch(function () {
      if (statGh) statGh.textContent = "github ↗";
    });

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

  // The signal trace uses the island's ink colour, so it stays visible whether
  // the island is dark (light mode) or light (dark mode).
  function islandInk() {
    return getComputedStyle(document.documentElement).getPropertyValue("--island-ink").trim() || "#f2f2ee";
  }
  var sigColor = islandInk();
  new MutationObserver(function () {
    sigColor = islandInk();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-paper", "data-theme"] });

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
    sctx.globalAlpha = 0.92;
    sctx.strokeStyle = sigColor;
    sctx.lineWidth = 1.3;
    sctx.stroke();
    sctx.globalAlpha = 1;

    vizFrame(ts || t * 16);
  }

  if (reduced) {
    sctx.beginPath();
    sctx.moveTo(0, H / 2);
    sctx.lineTo(W, H / 2);
    sctx.globalAlpha = 0.7;
    sctx.strokeStyle = sigColor;
    sctx.lineWidth = 1.3;
    sctx.stroke();
    sctx.globalAlpha = 1;
  } else {
    requestAnimationFrame(frame);
  }
})();

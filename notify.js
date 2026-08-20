// Visit notifier: pings a Google Apps Script web app once per browser
// session, which emails the site owner. NOTIFY_ENDPOINT is the "Web app"
// URL from Deploy in notify/Code.gs. Leave it empty and this file does
// nothing.
//
// Open the site once with ?me in the URL (lakshyav.is-a.dev/?me) on
// your own devices and they will stop notifying you about yourself.
(function () {
  var NOTIFY_ENDPOINT = "https://script.google.com/macros/s/AKfycbzfZQXu0x8hHwkPEY0gV8OQKONfKrIPiNE4JUGkoVXK0DaCaYXYgb1rpDOCvOcVt4UM1w/exec";

  try {
    if (new URLSearchParams(location.search).has("me")) {
      localStorage.setItem("notify-owner", "1");
    }
    if (!NOTIFY_ENDPOINT) return;
    if (localStorage.getItem("notify-owner") === "1") return;
    if (sessionStorage.getItem("notify-sent") === "1") return;
    if (navigator.webdriver) return; // headless browsers / crawlers
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
    sessionStorage.setItem("notify-sent", "1");
  } catch (_) {
    return;
  }

  // ---- device from the user agent -------------------------------------

  function parseUA(ua) {
    var r = { os: "", osVersion: "", browser: "", browserVersion: "", device: "desktop", model: "" };
    var m;

    if ((m = ua.match(/iPhone OS (\d+)[._](\d+)/))) { r.os = "iOS"; r.osVersion = m[1] + "." + m[2]; r.device = "phone"; r.model = "iPhone"; }
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) { r.os = "iPadOS"; r.device = "tablet"; r.model = "iPad"; if ((m = ua.match(/OS (\d+)[._](\d+)/))) r.osVersion = m[1] + "." + m[2]; }
    else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) {
      r.os = "Android"; r.osVersion = m[1];
      r.device = /Mobile/.test(ua) ? "phone" : "tablet";
      if ((m = ua.match(/Android [^;]+; ([^;)]+?)(?: Build|\))/))) r.model = m[1].trim();
    }
    else if (/Mac OS X/.test(ua)) { r.os = "macOS"; r.model = "Mac"; } // version is frozen at 10.15 by browsers, so not reported
    else if ((m = ua.match(/Windows NT (\d+\.\d+)/))) { r.os = "Windows"; r.osVersion = { "10.0": "10/11", "6.3": "8.1", "6.1": "7" }[m[1]] || m[1]; r.model = "PC"; }
    else if (/CrOS/.test(ua)) { r.os = "ChromeOS"; r.model = "Chromebook"; }
    else if (/Linux/.test(ua)) { r.os = "Linux"; r.model = "PC"; }

    var b = [
      [/EdgA?\/(\d+)/, "Edge"], [/OPR\/(\d+)/, "Opera"], [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
      [/Firefox\/(\d+)/, "Firefox"], [/FxiOS\/(\d+)/, "Firefox"], [/CriOS\/(\d+)/, "Chrome"],
      [/Chrome\/(\d+)/, "Chrome"], [/Version\/(\d+).*Safari/, "Safari"],
    ];
    for (var i = 0; i < b.length; i++) {
      if ((m = ua.match(b[i][0]))) { r.browser = b[i][1]; r.browserVersion = m[1]; break; }
    }
    var inApp = ua.match(/\b(Instagram|FBAN|FBAV|Twitter|LinkedInApp|Snapchat|Discord|Slack|TikTok|GSA)\b/);
    if (inApp) r.browser = (inApp[1] === "FBAN" || inApp[1] === "FBAV" ? "Facebook" : inApp[1] === "GSA" ? "Google app" : inApp[1]) + " in-app";
    return r;
  }

  function gpu() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      var s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
      // "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" -> "Apple M2"
      var m = s.match(/ANGLE \([^,]+, (?:ANGLE )?(?:Metal Renderer: )?([^,]+)/);
      return (m ? m[1] : s).replace(/\s*(Direct3D|OpenGL|Metal).*$/, "").trim();
    } catch (_) { return ""; }
  }

  // ---- visit history for this browser ---------------------------------

  function visitHistory() {
    try {
      var raw = JSON.parse(localStorage.getItem("notify-visits") || "{}");
      var h = { count: (raw.count || 0) + 1, first: raw.first || Date.now(), last: raw.last || null };
      localStorage.setItem("notify-visits", JSON.stringify({ count: h.count, first: h.first, last: Date.now() }));
      return h;
    } catch (_) { return { count: 1 }; }
  }

  // ---- approximate location from the visitor's IP ---------------------
  // Two free, keyless, CORS-enabled lookups; whichever answers first
  // within 3.5s wins, otherwise the email just goes out without it.

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, ms); })]);
  }

  function geo() {
    var a = fetch("https://ipapi.co/json/").then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.error) throw new Error("ipapi");
      return { ip: j.ip, city: j.city, region: j.region, country: j.country_name, countryCode: j.country_code, org: j.org, postal: j.postal, src: "ipapi.co" };
    });
    var b = fetch("https://ipwho.is/").then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.success === false) throw new Error("ipwho");
      return { ip: j.ip, city: j.city, region: j.region, country: j.country, countryCode: j.country_code, org: j.connection && (j.connection.org || j.connection.isp), postal: j.postal, src: "ipwho.is" };
    });
    // Promise.any with a fallback for older browsers.
    var any = typeof Promise.any === "function"
      ? Promise.any([a, b])
      : new Promise(function (res, rej) { var n = 0; [a, b].forEach(function (p) { p.then(res, function () { if (++n === 2) rej(); }); }); });
    return withTimeout(any, 3500).catch(function () { return null; });
  }

  // ---- assemble + send ------------------------------------------------

  function ship(loc) {
    var ua = navigator.userAgent;
    var d = parseUA(ua);
    var hist = visitHistory();
    var conn = navigator.connection || {};
    var qs = new URLSearchParams(location.search);

    var payload = {
      page: location.pathname + (location.search && location.search !== "?" ? location.search : ""),
      referrer: document.referrer || "",
      utm: ["utm_source", "utm_medium", "utm_campaign", "ref"].map(function (k) { return qs.get(k) ? k + "=" + qs.get(k) : ""; }).filter(Boolean).join(" "),
      language: (navigator.languages || [navigator.language]).join(", "),
      timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ""; } })(),
      screen: screen.width + "x" + screen.height + (devicePixelRatio > 1 ? " @" + Math.round(devicePixelRatio * 10) / 10 + "x" : ""),
      viewport: innerWidth + "x" + innerHeight,
      touch: navigator.maxTouchPoints > 0,
      darkMode: matchMedia("(prefers-color-scheme: dark)").matches,
      connection: [conn.effectiveType, conn.saveData ? "data-saver" : ""].filter(Boolean).join(" "),
      device: d,
      gpu: gpu(),
      cores: navigator.hardwareConcurrency || 0,
      memory: navigator.deviceMemory || 0,
      visits: hist,
      loc: loc,
      userAgent: ua,
    };

    fetch(NOTIFY_ENDPOINT, {
      method: "POST",
      mode: "no-cors",       // Apps Script doesn't send CORS headers; fire and forget
      keepalive: true,       // survives the tab closing right away
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  geo().then(ship, function () { ship(null); });
})();

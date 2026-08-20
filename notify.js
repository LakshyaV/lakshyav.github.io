// Visit notifier: pings a Google Apps Script web app once per browser
// session, which emails the site owner. Set NOTIFY_ENDPOINT to the
// "Web app" URL you get from Deploy in notify/Code.gs. Leave it empty
// and this file does nothing.
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

    var payload = {
      page: location.pathname + location.search,
      referrer: document.referrer || "(direct)",
      language: navigator.language,
      timezone: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ""; }
      })(),
      screen: screen.width + "x" + screen.height,
      touch: navigator.maxTouchPoints > 0,
      userAgent: navigator.userAgent,
    };

    sessionStorage.setItem("notify-sent", "1");
    fetch(NOTIFY_ENDPOINT, {
      method: "POST",
      mode: "no-cors",       // Apps Script doesn't send CORS headers; fire and forget
      keepalive: true,       // survives the tab closing right away
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    }).catch(function () {});
  } catch (_) {}
})();

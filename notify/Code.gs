// Paste this into a new project at https://script.google.com while signed
// in as lakyvasu22@gmail.com, then Deploy > New deployment > Web app with
// "Execute as: Me" and "Who has access: Anyone". Copy the web app URL into
// NOTIFY_ENDPOINT in notify.js.
//
// Mail is sent from the account that deploys it, so no passwords or API
// keys live in the site. Consumer Gmail allows ~100 emails/day from Apps
// Script; MAX_PER_HOUR below keeps a burst of traffic (or someone poking
// the endpoint) from eating that quota or flooding your inbox.

var TO = "lakyvasu22@gmail.com";
var MAX_PER_HOUR = 20;

function doPost(e) {
  var cache = CacheService.getScriptCache();
  var sent = Number(cache.get("sent-this-hour") || 0);
  if (sent >= MAX_PER_HOUR) return ok("rate-limited");
  cache.put("sent-this-hour", String(sent + 1), 3600);

  var d = {};
  try { d = JSON.parse(e.postData.contents); } catch (_) {}

  var when = Utilities.formatDate(new Date(), "America/Toronto", "EEE d MMM yyyy, h:mm a z");
  var lines = [
    "someone opened lakshyav.is-a.dev",
    "",
    "when:      " + when,
    "page:      " + (d.page || "/"),
    "referrer:  " + (d.referrer || "(direct)"),
    "timezone:  " + (d.timezone || "?"),
    "language:  " + (d.language || "?"),
    "screen:    " + (d.screen || "?") + (d.touch ? " (touch)" : ""),
    "browser:   " + (d.userAgent || "?"),
  ];

  MailApp.sendEmail({
    to: TO,
    subject: "visitor on lakshyav.is-a.dev" + (d.referrer && d.referrer !== "(direct)" ? " via " + d.referrer : ""),
    body: lines.join("\n"),
  });
  return ok("sent");
}

// Visiting the web app URL in a browser shows this instead of an error.
function doGet() {
  return ok("up");
}

function ok(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

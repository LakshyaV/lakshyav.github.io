// Source of truth for the "lakshyav.is-a.dev visit notifier" Apps Script
// project (see README). Deployed as a Web app with "Execute as: Me" and
// "Who has access: Anyone"; the /exec URL lives in notify.js.
//
// After editing: paste into the editor, then Deploy > Manage deployments
// > edit (pencil) > Version: New version > Deploy. The URL stays the same.
//
// Mail is sent from the account that deploys it, so no passwords or API
// keys live in the site. Consumer Gmail allows ~100 emails/day from Apps
// Script; MAX_PER_HOUR keeps a burst of traffic (or someone poking the
// endpoint) from eating that quota or flooding your inbox.

var TO = "lakyvasu22@gmail.com";
var MAX_PER_HOUR = 20;
var MY_TZ = "America/Toronto";

function doPost(e) {
  var cache = CacheService.getScriptCache();
  var sent = Number(cache.get("sent-this-hour") || 0);
  if (sent >= MAX_PER_HOUR) return ok("rate-limited");
  cache.put("sent-this-hour", String(sent + 1), 3600);

  var d = {};
  try { d = JSON.parse(e.postData.contents); } catch (_) {}
  var dev = d.device || {};
  var loc = d.loc || {};
  var v = d.visits || {};

  // --- derived bits ---------------------------------------------------
  var now = new Date();
  var when = Utilities.formatDate(now, MY_TZ, "EEE d MMM, h:mm a");
  var theirTime = "";
  if (d.timezone && d.timezone !== MY_TZ) {
    try { theirTime = Utilities.formatDate(now, d.timezone, "h:mm a") + " their time"; } catch (_) {}
  }

  var place = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  var refHost = (d.referrer || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  var via = refHost ? "via " + refHost : "direct";
  if (d.utm) via += " (" + d.utm + ")";

  var deviceLine = describeDevice(dev, d);
  var who = v.count > 1
    ? "returning, visit #" + v.count + (v.first ? " (first seen " + Utilities.formatDate(new Date(v.first), MY_TZ, "d MMM") + ")" : "")
    : "first time in this browser";

  // --- subject --------------------------------------------------------
  var subject = [place || "somewhere", shortDevice(dev), via].join(" · ");

  // --- body -----------------------------------------------------------
  var lines = [
    "someone opened lakshyav.is-a.dev" + (d.page && d.page !== "/" ? d.page : ""),
    "",
    "when       " + when + (theirTime ? "  (" + theirTime + ")" : ""),
    "from       " + via,
    "",
    "WHERE",
    "place      " + (place || "unknown"),
    "network    " + (loc.org || "unknown"),
    "ip         " + (loc.ip || "unknown"),
    "timezone   " + (d.timezone || "?"),
    "language   " + (d.language || "?"),
    "",
    "DEVICE",
    "device     " + deviceLine,
    "browser    " + [dev.browser, dev.browserVersion].filter(Boolean).join(" "),
    "screen     " + (d.screen || "?") + (d.viewport ? ", viewport " + d.viewport : "") + (d.touch ? ", touch" : "") + (d.darkMode ? ", dark mode" : ""),
    "network    " + (d.connection || "?"),
    "",
    "HISTORY",
    "visitor    " + who,
    "",
    "raw ua     " + (d.userAgent || "?"),
  ];

  MailApp.sendEmail({
    to: TO,
    subject: subject,
    body: lines.join("\n"),
    name: "lakshyav.is-a.dev",
  });
  return ok("sent");
}

function describeDevice(dev, d) {
  var parts = [];
  var model = dev.model || "";
  if (model === "Mac" && d.gpu && /Apple/.test(d.gpu)) model = "Mac (" + d.gpu + ")";
  else if ((model === "PC" || !model) && d.gpu) model = (model || "") + " (" + d.gpu + ")";
  parts.push(model || dev.device || "?");
  if (dev.os) parts.push(dev.os + (dev.osVersion ? " " + dev.osVersion : ""));
  var hw = [];
  if (d.cores) hw.push(d.cores + " cores");
  if (d.memory) hw.push(d.memory + "GB+ ram");
  if (hw.length) parts.push(hw.join(", "));
  return parts.join(" · ");
}

function shortDevice(dev) {
  var m = dev.model || dev.device || "unknown device";
  if (m === "Mac" || m === "PC") m = m + (dev.os ? " / " + dev.os : "");
  return m + (dev.browser ? " / " + dev.browser : "");
}

// Visiting the web app URL in a browser shows this instead of an error.
function doGet() {
  return ok("up");
}

function ok(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

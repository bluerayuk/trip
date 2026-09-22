/* ============ Google Maps link parsing (address field) ============ */
// When someone pastes a Google Maps link into the "Address" field, this module:
//   1. pulls the place name out of the link and swaps it in for the raw URL
//      (so the saved address reads "Statue of Liberty", not a 300-char URL), and
//   2. remembers the exact lat/lng from the link in `pendingCoords`, which
//      submitForm() (app.js) reads and clears when the stop is saved.
//
// Plain (non-module) script sharing globals with app.js. Nothing here runs at
// startup: handleAddressPaste is wired to the address input's onpaste in
// index.html, and parseGoogleMapsLink is called from submitForm. It is loaded
// before app.js for consistency.
//
//   - Used from app.js: showToast.
//   - Exposed to app.js / index.html: parseGoogleMapsLink, handleAddressPaste,
//     and the `pendingCoords` state (owned here; submitForm reads and resets it).
//
// Note: stops store lat/lng, but nothing in the app currently reads them back
// (see the NOTE below). What users see today is the link -> clean name swap.

/* ---- Parsing ---- */
// NOTE: this was originally built to feed Citymapper's `endcoord` param
// (now removed). Nothing currently reads place.lat/place.lng — they're
// still captured and stored below, but purely as leftover plumbing.
// This app runs inside a Claude.ai artifact, and artifacts run in a
// sandboxed iframe that blocks fetch() to arbitrary third-party domains
// (like a geocoding API), so we can't resolve coordinates over the
// network. Instead: if the address field contains a Google Maps link
// (Share -> Copy link on a place), we pull the lat/lng straight out of
// the URL itself — that's pure string parsing, no network call needed.
//
// Works with links like:
//   https://www.google.com/maps/place/Statue+of+Liberty/@40.6892,-74.0445,17z/data=...!3d40.6892494!4d-74.0445004...
//   https://www.google.com/maps?q=40.6892,-74.0445
// Does NOT work with shortened links (maps.app.goo.gl/...) since those
// only reveal real coordinates after a server redirect we can't follow.
function parseGoogleMapsLink(text) {
  const t = (text || '').trim();
  if (!/^https?:\/\//i.test(t) || !/google\.[a-z.]+\/maps|maps\.google\./i.test(t)) return null;
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(t)) {
    return { shortened: true };
  }
  // Prefer the precise pin coords (!3d<lat>!4d<lng>) over the map's
  // camera-center coords (@<lat>,<lng>) since the latter can drift once
  // you've panned/zoomed before copying the link.
  let m = t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!m) m = t.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  let name = null;
  const nameMatch = t.match(/\/maps\/place\/([^/]+)\//);
  if (nameMatch) { try { name = decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')); } catch (e) { /* leave null */ } }
  return { lat, lng, name };
}

// Live-formats the address field as the user pastes: if it's a full
// Google Maps link, swap it for a clean address/name and remember the
// coordinates on the form (read back in submitForm) instead of storing
// the raw URL as the "address".
let pendingCoords = null; // {lat,lng} captured from the last pasted Maps link, consumed on submit

/* ---- Paste handler ---- */
function handleAddressPaste() {
  const input = document.getElementById('placeAddress');
  const parsed = parseGoogleMapsLink(input.value);
  if (!parsed) { pendingCoords = null; return; }
  if (parsed.shortened) {
    showToast("Shortened Maps links don't carry coordinates — use the full google.com/maps link instead");
    pendingCoords = null;
    return;
  }
  pendingCoords = { lat: parsed.lat, lng: parsed.lng };
  if (parsed.name) input.value = parsed.name;
  showToast('Exact location captured from Google Maps link');
}

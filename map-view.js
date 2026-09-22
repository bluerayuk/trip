/* ============ Map view (MapLibre GL + OpenFreeMap) ============ */
// Renders the "Map" view: an interactive map with one pin per visible stop.
// No API key, no billing account, no request limits.
//
// This module went through three tile providers before landing here:
//   - tile.openstreetmap.org (OSM's own servers) 403s hotlinked/sandboxed
//     traffic per its usage policy.
//   - basemaps.cartocdn.com (CARTO) now requires an API key.
//   - maps.wikimedia.org worked at low zoom but broke down at higher zoom
//     levels (likely the same kind of hotlink restriction).
// All three are raster tile CDNs, which turns out to be the wrong category
// of free service to lean on — they're built for individual sites' own
// basemaps, not for arbitrary embedding. OpenFreeMap (openfreemap.org) is
// built specifically for the latter: a public vector-tile service, explicit
// "no limits on the number of map views or requests... no API keys", data
// from OpenStreetMap. It's rendered with MapLibre GL (a WebGL vector map
// library) rather than Leaflet, since that's the format OpenFreeMap serves.
//
// Where a pin's coordinates come from, in order:
//   1. place.lat / place.lng, if already saved. These get set either by
//      pasting a Google Maps link into the address field (maps-link.js
//      pulls the exact coords straight out of the URL), or by a previous
//      successful geocode from this module.
//   2. Otherwise, place.address is looked up with Nominatim (OpenStreetMap's
//      free geocoder — unrelated to OpenFreeMap, just the same underlying
//      map data). A resolved address is written back onto the place and
//      persisted, so it's only ever geocoded once.
//   3. If Nominatim can't resolve it (offline, the service is down, or
//      nothing matches), the stop drops into a small "couldn't place on
//      map" list with a manual Locate button to retry, plus a fallback
//      link to search for it directly on Google Maps.
//
// "Show on map" (showOnMap), pin highlight-on-hover and the Split view live under
// "Show on map, pin highlight, and the split view" below.
//
// A category legend above the map toggles pins on/off, and "Fit all" /
// "Fit to Manhattan" buttons reframe the camera (see "Layer toggles" below).
//
// Every marker's popup links out to Google Maps for turn-by-turn
// directions — this module itself never calls or embeds Google Maps.
//
// The route helper ("pick a start, then the closest next stop") lives in nearest.js. This file
// only calls into it at a few points: popup content, pin creation, legend toggles, geocode results,
// split-list rows and map creation - each guarded with typeof so this file also works without it.
//
// Plain (non-module) script sharing globals with app.js, same pattern as
// my-list.js / maps-link.js:
//   - Used from app.js: places, persistPlaces, escapeHtml, categoryDotColor,
//     categoryLabel.
//   - Exposed to app.js / inline onclick handlers: renderMapView, retryGeocode.
// Load order (see index.html): MapLibre GL's own JS/CSS (from cdnjs), then
// this file, then app.js. renderMapView() isn't called until the user picks
// the "Map" view, by which point app.js has fully loaded and initialized.

/* ---- Nominatim geocoding ---- */
// Nominatim's usage policy caps unauthenticated use at ~1 request/second,
// so every geocode goes through this single queue instead of firing in
// parallel — keeps this app a good citizen and avoids getting throttled.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_MIN_GAP_MS = 1100;
let geocodeQueueTail = Promise.resolve();

function queueGeocode(place) {
  const run = () => geocodePlace(place);
  const wait = () => new Promise(resolve => setTimeout(resolve, NOMINATIM_MIN_GAP_MS));
  const next = geocodeQueueTail.then(wait, wait).then(run);
  geocodeQueueTail = next.catch(() => {}); // one failure shouldn't jam up the next request
  return next;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Bias (not restrict) results to the NYC / Long Island / north-NJ area so a
// name-only fallback like "Burlington" can't land in Vermont.
const NOMINATIM_VIEWBOX = '-74.45,40.45,-73.35,41.10';

async function nominatimSearch(q) {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=us&viewbox=${NOMINATIM_VIEWBOX}&bounded=0&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; } // throttled: back off and retry
    if (!res.ok) throw new Error(`The geocoder returned ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  throw new Error('The geocoder is rate-limiting requests - try again in a minute');
}

// Ordered list of things to look up for one stop, best first. Street addresses
// in this app are often not what Nominatim wants ("Broadway between 45th St and
// 46th St", "Ste 100", "Corner of X and Y", a bare "East Meadow, NY 11554"),
// so each stop gets a few progressively looser tries. `approx` marks results
// that are a neighbourhood/ZIP guess rather than the exact spot.
function buildGeocodeQueries(place) {
  const addr = (place.address || '').trim();
  const queries = [];
  const add = (q, approx) => {
    q = (q || '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    if (q && !queries.some(x => x.q.toLowerCase() === q.toLowerCase())) queries.push({ q, approx: !!approx });
  };

  // City / state / ZIP, when the address ends like "..., East Meadow, NY 11554"
  const m = addr.match(/(?:^|,)\s*([^,]+?),\s*([A-Z]{2})\s*(\d{5})?\s*$/);
  const city = m ? m[1] : 'New York';
  const state = m ? m[2] : 'NY';
  const zip = m && m[3] ? m[3] : '';

  // 1) the address exactly as typed
  add(addr);

  // 2) the address with the parts geocoders choke on cleaned up
  const cleaned = addr
    .replace(/\(.*?\)/g, ' ')
    .replace(/,?\s*\b(?:Suite|Ste|Unit|Fl|Floor)\.?\s*[\w-]+/ig, '')
    .replace(/^Corner of\s+/i, '')
    .replace(/(.+?)\s+between\s+(.+?)\s+and\s+[^,]+/i, '$1 & $2')
    .replace(/\s+and\s+(?=\d|[A-Z])/g, ' & ')
    .replace(/^\d+-(\d+)\s/, '$1 ')      // "198-100 W 32nd St" -> "100 W 32nd St"
    .replace(/\s+at\s+(?=W |E |Pier)/i, ', ');
  add(cleaned);

  // 3) the place's name in the same town
  const bareName = (place.name || '').replace(/\(.*?\)/g, ' ');
  add(`${bareName}, ${city}, ${state}`);

  // 4) last resort: the ZIP code / town centre (approximate)
  if (zip) add(`${city}, ${state} ${zip}`, true);
  else add(`${city}, ${state}`, true);

  return queries;
}

async function geocodePlace(place) {
  const queries = buildGeocodeQueries(place);
  let lastErr = null;
  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await sleep(NOMINATIM_MIN_GAP_MS);
    try {
      const hit = await nominatimSearch(queries[i].q);
      if (hit) return { ...hit, approx: queries[i].approx };
    } catch (err) { lastErr = err; }
  }
  if (lastErr) throw lastErr; // nothing found AND something actually went wrong
  return null;                // simply no match
}

/* ---- Module state ---- */
// All keyed off the currently-rendered map, so a stale async response from
// a previous render (e.g. the user flipped back to Grid mid-geocode) can
// recognize itself as stale and bail out quietly.
let maplibreMap = null;
let mapRenderId = 0;
let markerById = {};          // place.id -> maplibregl.Marker, for the current render
let unresolvedIds = [];       // ids of visible places with no lat/lng, for the current render
let pendingGeocodeIds = new Set();
let failedGeocodeIds = new Set();
let unlocatedPanelEl = null;
let mapResizeObserver = null;
// Layer-toggle state. Deliberately module-level (not reset in renderMapView) so
// hidden categories and the chosen fit mode survive the map being rebuilt by
// renderPlaces() (star ratings, My attractions toggles, shared-trip polling...).
let hiddenMapCategories = new Set();
let mapFitMode = 'all';        // 'all' | 'manhattan'
let currentMapPlaces = [];     // the `visible` list for the current render
let mapControlsEl = null;
let mapMyListOnly = false;    // "My list only" toggle
// Stops that already failed to geocode this session. Without this, every map
// re-render (a star rating, a shortlist change...) would re-run all the failing
// lookups. "Locate" / "Locate all" clear the entry and try again.
const permanentlyFailed = new Set();
const geocodeFailureReason = {};
const failKey = (p) => `${p.id}|${p.address}`;
function noteGeocodeFailure(place, reason) { permanentlyFailed.add(failKey(place)); geocodeFailureReason[place.id] = reason; }

// Pin names appear at this zoom level and above (roughly neighbourhood scale).
const LABEL_MIN_ZOOM = 14;

let selectedMapId = null;      // pin currently selected (popup open) - mirrored onto the split-view list
let pendingFocusId = null;     // a "Show on map" request waiting for its pin to exist (map loading / geocoding)
let mapAutoFit = true;         // false once we've flown somewhere or the user moved the map, so late geocodes don't yank the camera

/* ---- Google Maps hand-off ---- */
// Precise coords give exact turn-by-turn; falling back to the address still
// gets a usable directions link for stops that haven't been geocoded yet.
function googleMapsDirectionsUrl(place) {
  const dest = (typeof place.lat === 'number' && typeof place.lng === 'number')
    ? `${place.lat},${place.lng}`
    : (place.address || place.name || null);
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

/* ---- Rendering ---- */
const MYLIST_PIN_BADGE_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#fff" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1V14l-5-3-5 3V3.5a1 1 0 0 1 1-1z"/></svg>';

// Shortlisted ("My attractions") stops get a larger pin with a bookmark badge
// so they stand out from the rest of the trip.
function buildMarkerEl(place) {
  const inList = isInMyList(place.id);
  const el = document.createElement('div');
  el.className = 'map-pin-icon' + (inList ? ' is-mylist' : '');
  const color = categoryDotColor(place.category) || 'var(--accent)';
  el.innerHTML = `
    <span class="map-pin-dot" style="background:${color}">${inList ? MYLIST_PIN_BADGE_SVG : ''}</span>
    <span class="map-pin-label">${escapeHtml(place.name)}</span>
  `;
  return el;
}

function buildPopupHtml(place) {
  const dirUrl = googleMapsDirectionsUrl(place);
  return `
    <div class="map-popup">
      <div class="map-popup-category" style="color:${categoryDotColor(place.category) || 'inherit'}">${escapeHtml(categoryLabel(place.category))}</div>
      <div class="map-popup-title">${escapeHtml(place.name)}</div>
      ${place.approxLocation ? '<div class="map-popup-approx">Approximate location - use Fix address for an exact pin</div>' : ''}
      ${isInMyList(place.id) ? '<div class="map-popup-mylist">In My attractions</div>' : ''}
      ${place.address ? `<div class="map-popup-address">${escapeHtml(place.address)}</div>` : ''}
      ${place.desc ? `<button type="button" class="map-popup-details" onclick="openDetailModal('${place.id}')">View insider tips</button>` : ''}
      ${typeof tourPopupHtml === 'function' ? tourPopupHtml(place) : ''}
      ${dirUrl ? `<a class="map-popup-directions" href="${dirUrl}" target="_blank" rel="noopener">Directions in Google Maps ↗</a>` : ''}
    </div>`;
}

function addOrUpdateMarker(place) {
  if (markerById[place.id]) { markerById[place.id].remove(); }
  const popup = new maplibregl.Popup({ offset: isInMyList(place.id) ? 20 : 14, closeButton: true }).setHTML(buildPopupHtml(place));
  popup.on('open', () => selectMapPin(place.id, true));
  popup.on('close', () => { if (selectedMapId === place.id) selectMapPin(null); });
  const marker = new maplibregl.Marker({ element: buildMarkerEl(place), anchor: 'center' })
    .setLngLat([place.lng, place.lat])
    .setPopup(popup)
    .addTo(maplibreMap);
  markerById[place.id] = marker;
  if (typeof decorateTourMarker === 'function') decorateTourMarker(place, false); // route number / suggestion highlight (nearest.js)
  // Markers geocoded after the fact must respect the current legend state.
  marker.getElement().style.display = isPlaceHiddenOnMap(place) ? 'none' : '';
}

/* ---- Layer toggles: category legend + fit buttons ---- */
// Roughly Manhattan plus its close waterfront (DUMBO / Brooklyn Heights), so
// Long Island, NJ and Staten Island stops don't force the map to zoom way out.
const MANHATTAN_BOUNDS = { south: 40.695, north: 40.885, west: -74.03, east: -73.90 };

// One rule for "is this pin hidden right now": category switched off, or
// "My list only" is on and the stop isn't shortlisted.
function isPlaceHiddenOnMap(place) {
  if (hiddenMapCategories.has(place.category)) return true;
  return mapMyListOnly && !isInMyList(place.id);
}

function inManhattanBounds(ll) {
  return ll.lat >= MANHATTAN_BOUNDS.south && ll.lat <= MANHATTAN_BOUNDS.north &&
         ll.lng >= MANHATTAN_BOUNDS.west && ll.lng <= MANHATTAN_BOUNDS.east;
}

// Only markers whose category is currently switched on.
function visibleMarkers() {
  return Object.entries(markerById)
    .filter(([id]) => {
      const p = places.find(x => x.id === id);
      return p && !isPlaceHiddenOnMap(p);
    })
    .map(([, m]) => m);
}

function fitToMarkers(animate) {
  if (!maplibreMap) return;
  let list = visibleMarkers();
  if (mapFitMode === 'manhattan') {
    const core = list.filter(m => inManhattanBounds(m.getLngLat()));
    if (core.length) list = core; // nothing in Manhattan? fall back to everything
  }
  if (!list.length) return;
  if (list.length === 1) {
    const opts = { center: list[0].getLngLat(), zoom: 14 };
    if (animate) maplibreMap.flyTo(opts); else maplibreMap.jumpTo(opts);
    return;
  }
  const bounds = list.reduce(
    (b, m) => b.extend(m.getLngLat()),
    new maplibregl.LngLatBounds(list[0].getLngLat(), list[0].getLngLat())
  );
  maplibreMap.fitBounds(bounds, { padding: 60, maxZoom: 15, animate: !!animate });
}

// Shows/hides every marker according to hiddenMapCategories, closing popups on
// pins that just disappeared, then syncs the legend chips.
function applyCategoryVisibility() {
  Object.entries(markerById).forEach(([id, marker]) => {
    const p = places.find(x => x.id === id);
    const hidden = !p || isPlaceHiddenOnMap(p);
    marker.getElement().style.display = hidden ? 'none' : '';
    if (hidden) {
      const pop = marker.getPopup();
      if (pop && pop.isOpen()) marker.togglePopup();
    }
  });
  updateMapControlsUi();
  if (typeof refreshTour === 'function') refreshTour(); // the route helper only suggests stops that are visible (nearest.js)
}

function updateMapControlsUi() {
  if (!mapControlsEl) return;
  mapControlsEl.querySelectorAll('.map-legend-chip').forEach(chip => {
    const off = hiddenMapCategories.has(chip.dataset.cat);
    chip.classList.toggle('off', off);
    chip.setAttribute('aria-pressed', off ? 'false' : 'true');
  });
  mapControlsEl.querySelectorAll('[data-fit]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fit === mapFitMode);
  });
  const myBtn = mapControlsEl.querySelector('[data-action="mylist"]');
  if (myBtn) {
    myBtn.classList.toggle('active', mapMyListOnly);
    myBtn.setAttribute('aria-pressed', mapMyListOnly ? 'true' : 'false');
  }
  const status = mapControlsEl.querySelector('.map-legend-status');
  if (status) {
    const total = currentMapPlaces.length;
    const shown = currentMapPlaces.filter(p => !isPlaceHiddenOnMap(p)).length;
    status.textContent = shown === total ? `${total} stop${total !== 1 ? 's' : ''}` : `Showing ${shown} of ${total} stops`;
  }
}

function buildMapControls(visible, wrap, mapEl) {
  currentMapPlaces = visible;
  const myCount = getMyListPlaces().length;
  if (myCount === 0) mapMyListOnly = false; // nothing shortlisted -> can't stay filtered to it
  const counts = {};
  visible.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
  const ordered = [
    ...Object.keys(CATEGORY_LABELS).filter(c => counts[c]),
    ...Object.keys(counts).filter(c => !(c in CATEGORY_LABELS))
  ];

  const bar = document.createElement('div');
  bar.className = 'map-controls';
  bar.innerHTML = `
    <div class="map-legend" role="group" aria-label="Show or hide categories on the map">
      ${ordered.map(cat => `
        <button type="button" class="map-legend-chip" data-cat="${escapeHtml(cat)}" aria-pressed="true">
          <span class="map-legend-dot" style="background:${categoryDotColor(cat) || 'var(--accent)'}"></span>
          <span class="map-legend-label">${escapeHtml(categoryLabel(cat))}</span>
          <span class="map-legend-count">${counts[cat]}</span>
        </button>`).join('')}
    </div>
    <div class="map-controls-actions">
      <button type="button" class="icon-text-btn map-mylist-toggle" data-action="mylist" aria-pressed="false"${myCount ? '' : ' disabled title="Add stops to My attractions first"'}>
        ${MYLIST_PIN_BADGE_SVG.replace('fill="#fff"', 'fill="currentColor"')} My list only (${myCount})
      </button>
      <span class="map-controls-sep" aria-hidden="true"></span>
      <button type="button" class="icon-text-btn" data-action="all">All</button>
      <button type="button" class="icon-text-btn" data-action="none">None</button>
      <span class="map-controls-sep" aria-hidden="true"></span>
      <button type="button" class="icon-text-btn" data-fit="all">Fit all</button>
      <button type="button" class="icon-text-btn" data-fit="manhattan">Fit to Manhattan</button>
      <span class="map-legend-status" aria-live="polite"></span>
    </div>`;

  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.map-legend-chip');
    if (chip) {
      const cat = chip.dataset.cat;
      if (hiddenMapCategories.has(cat)) hiddenMapCategories.delete(cat); else hiddenMapCategories.add(cat);
      applyCategoryVisibility();
      return;
    }
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'mylist') mapMyListOnly = !mapMyListOnly;
      else if (action === 'all') { hiddenMapCategories.clear(); mapMyListOnly = false; }
      else ordered.forEach(c => hiddenMapCategories.add(c));
      applyCategoryVisibility();
      return;
    }
    const fitBtn = e.target.closest('[data-fit]');
    if (fitBtn) {
      mapFitMode = fitBtn.dataset.fit;
      updateMapControlsUi();
      fitToMarkers(true);
    }
  });

  wrap.insertBefore(bar, mapEl);
  mapControlsEl = bar;
  updateMapControlsUi();
}

function renderUnlocatedPanel() {
  if (!unlocatedPanelEl) return;
  const stillUnresolved = unresolvedIds
    .map(id => places.find(p => p.id === id))
    .filter(p => p && !(typeof p.lat === 'number' && typeof p.lng === 'number'));

  if (!stillUnresolved.length) {
    unlocatedPanelEl.style.display = 'none';
    unlocatedPanelEl.innerHTML = '';
    return;
  }

  const isPendingP = (p) => pendingGeocodeIds.has(p.id) && !failedGeocodeIds.has(p.id);
  const pendingCount = stillUnresolved.filter(isPendingP).length;
  const failedCount = stillUnresolved.length - pendingCount;
  const plural = (n) => `${n} stop${n !== 1 ? 's' : ''}`;
  const title = pendingCount
    ? `Locating ${plural(pendingCount)}…${failedCount ? ` ${failedCount} couldn't be placed yet` : ''}`
    : `Couldn't place ${plural(failedCount)} on the map`;

  unlocatedPanelEl.style.display = 'block';
  unlocatedPanelEl.innerHTML = `
    <div class="map-unlocated-head">
      <div class="map-unlocated-title">${escapeHtml(title)}</div>
      ${failedCount ? '<button type="button" class="icon-text-btn map-locate-btn" onclick="retryAllGeocodes()">Locate all</button>' : ''}
    </div>
    <ul class="map-unlocated-list">
      ${stillUnresolved.map(p => {
        const isPending = isPendingP(p);
        const reason = geocodeFailureReason[p.id];
        const searchUrl = p.address
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`
          : null;
        return `<li class="map-unlocated-item" data-id="${p.id}">
          <span class="map-unlocated-name">${escapeHtml(p.name)}</span>
          ${p.address ? `<span class="map-unlocated-address">${escapeHtml(p.address)}</span>` : `<span class="map-unlocated-address">No address saved</span>`}
          ${isPending
            ? `<span class="map-unlocated-status">Locating…</span>`
            : `${reason ? `<span class="map-unlocated-status">${escapeHtml(reason)}</span>` : ''}
               ${p.address ? `<button type="button" class="icon-text-btn map-locate-btn" onclick="retryGeocode('${p.id}')">Locate</button>` : ''}
               <button type="button" class="icon-text-btn map-locate-btn" onclick="startEdit('${p.id}')" title="Edit the address, or paste a Google Maps link for an exact pin">Fix address</button>`}
          ${searchUrl ? `<a class="map-unlocated-fallback" href="${searchUrl}" target="_blank" rel="noopener">Find on Google Maps ↗</a>` : ''}
        </li>`;
      }).join('')}
    </ul>`;
}

async function geocodeAndPlace(place, renderId) {
  pendingGeocodeIds.add(place.id);
  failedGeocodeIds.delete(place.id);
  renderUnlocatedPanel();
  try {
    const coords = await queueGeocode(place);
    if (renderId !== mapRenderId) return; // this render is gone; a newer one owns the map now
    pendingGeocodeIds.delete(place.id);
    if (!coords) {
      failedGeocodeIds.add(place.id);
      noteGeocodeFailure(place, 'Address not found');
      cancelPendingFocus(place.id);
      renderUnlocatedPanel();
      return;
    }
    place.lat = coords.lat;
    place.lng = coords.lng;
    if (coords.approx) place.approxLocation = true; else delete place.approxLocation;
    permanentlyFailed.delete(failKey(place));
    delete geocodeFailureReason[place.id];
    addOrUpdateMarker(place);
    if (typeof refreshTour === 'function') refreshTour(); // newly located stops join the suggestions (nearest.js)
    if (mapAutoFit) fitToMarkers();
    tryPendingFocus();
    renderUnlocatedPanel();
    await persistPlaces(); // save it so this address is never geocoded again
  } catch (err) {
    if (renderId !== mapRenderId) return;
    pendingGeocodeIds.delete(place.id);
    failedGeocodeIds.add(place.id);
    const offline = err instanceof TypeError; // fetch() itself failed: blocked, offline or CORS
    noteGeocodeFailure(place, offline ? "Couldn't reach the geocoding service (offline or blocked)" : (err && err.message) || 'Lookup failed');
    cancelPendingFocus(place.id);
    renderUnlocatedPanel();
  }
}

// Manual retry, wired to the "Locate" button in the unlocated panel. Also
// what a person reaches for after "no network access" was the problem the
// first time around — nothing else here auto-retries.
function retryAllGeocodes() {
  unresolvedIds
    .map(id => places.find(p => p.id === id))
    .filter(p => p && p.address && !(typeof p.lat === 'number' && typeof p.lng === 'number') && !pendingGeocodeIds.has(p.id))
    .forEach(p => { permanentlyFailed.delete(failKey(p)); geocodeAndPlace(p, mapRenderId); });
}

function retryGeocode(id) {
  const place = places.find(p => p.id === id);
  if (!place || !place.address) return;
  permanentlyFailed.delete(failKey(place));
  geocodeAndPlace(place, mapRenderId);
}

/* ---- Show on map, pin highlight, and the split view ---- */
const SPLIT_INFO_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5M12 7.6v.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SPLIT_EXTERNAL_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SPLIT_ROUTE_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SPLIT_PLACEHOLDER_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

// Everything the map (and the split-view list beside it) shows: the filtered
// stops plus shortlisted ones, in trip order. Shortlisted stops ignore the
// search box / category filter, like the My attractions section does.
function getMapPlaces(visible) {
  const ids = new Set(visible.map(p => p.id));
  getMyListPlaces().forEach(p => ids.add(p.id));
  return places.filter(p => ids.has(p.id));
}

function hasMapLocation(p) {
  return (typeof p.lat === 'number' && typeof p.lng === 'number') || !!(p.address && p.address.trim());
}

// Hover/focus highlight. Safe to call when no map is on screen (no-op).
function highlightPin(id, on) {
  const m = markerById[id];
  if (m) m.getElement().classList.toggle('is-highlighted', !!on);
}

// Marks one pin + one split-list row as "selected" (popup open). Pass null to clear.
function selectMapPin(id, scrollList) {
  selectedMapId = id;
  Object.entries(markerById).forEach(([mid, m]) => m.getElement().classList.toggle('is-selected', mid === id));
  const rows = [...document.querySelectorAll('.split-row')];
  rows.forEach(r => r.classList.toggle('active', r.dataset.id === id));
  if (id && scrollList) {
    const row = rows.find(r => r.dataset.id === id);
    const list = row && row.parentElement;
    if (list) {
      // Scroll only the list (not the page) so the row is fully in view.
      const head = list.querySelector('.split-list-head');
      const headH = head ? head.offsetHeight : 0;
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop + headH) list.scrollTo({ top: top - headH - 4, behavior: 'smooth' });
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight + 4, behavior: 'smooth' });
    }
  }
}

function closeAllPopups(exceptId) {
  Object.entries(markerById).forEach(([id, m]) => {
    const pop = m.getPopup();
    if (id !== exceptId && pop && pop.isOpen()) m.togglePopup();
  });
}

// Returns true if the pin existed and we flew to it.
function flyToPlace(id) {
  const place = places.find(p => p.id === id);
  const marker = markerById[id];
  if (!place || !marker || !maplibreMap) return false;

  // If a legend toggle / "My list only" is hiding this pin, undo just enough to show it.
  let changed = false;
  if (hiddenMapCategories.has(place.category)) { hiddenMapCategories.delete(place.category); changed = true; }
  if (mapMyListOnly && !isInMyList(place.id)) { mapMyListOnly = false; changed = true; }
  if (changed) applyCategoryVisibility();

  mapAutoFit = false;
  closeAllPopups(id);
  maplibreMap.flyTo({ center: marker.getLngLat(), zoom: Math.max(maplibreMap.getZoom(), 15), essential: true });
  if (!marker.getPopup().isOpen()) marker.togglePopup();
  return true;
}

function tryPendingFocus() {
  if (!pendingFocusId) return false;
  if (flyToPlace(pendingFocusId)) { pendingFocusId = null; return true; }
  return false;
}

function cancelPendingFocus(id) {
  if (pendingFocusId === id) {
    pendingFocusId = null;
    showToast("Couldn't find that address on the map");
  }
}

function scrollMapIntoView() {
  const el = document.querySelector('.map-view-wrap');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Public: "Show on map". From Grid/Route it switches to the Split view; if a
// map is already showing it just flies there. opts.scroll === false skips
// scrolling the page (used by split-view rows, which sit beside the map).
function showOnMap(id, opts = {}) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  if (!hasMapLocation(place)) { showToast('No address saved for this stop'); return; }
  pendingFocusId = id;
  if (currentView === 'map' || currentView === 'split') {
    if (!tryPendingFocus() && !pendingGeocodeIds.has(id)) showToast('Locating on the map…');
    if (opts.scroll !== false) scrollMapIntoView();
  } else {
    setView('split'); // renders the map; placeMarkers()/geocode finish the flight via tryPendingFocus()
    requestAnimationFrame(scrollMapIntoView);
  }
}

function buildSplitRow(place) {
  const inList = isInMyList(place.id);
  const pkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
  const costVal = pkg ? (parseFloat(pkg.cost) || 0)
    : (place.cost != null && place.cost !== '' ? parseFloat(place.cost) : null);
  const priceText = (costVal == null || Number.isNaN(costVal)) ? '' : (costVal === 0 ? 'Free' : '$' + costVal.toFixed(2));
  const located = hasMapLocation(place);
  const color = categoryDotColor(place.category) || 'var(--accent)';
  const gmapsQuery = (place.address && place.address.trim())
    ? place.address.trim()
    : (typeof place.lat === 'number' && typeof place.lng === 'number' ? `${place.lat},${place.lng}` : null);
  const gmapsUrl = gmapsQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gmapsQuery)}` : null;

  const row = document.createElement('div');
  row.className = 'split-row';
  row.dataset.id = place.id;
  row.innerHTML = `
    <button type="button" class="split-row-main" aria-label="Show ${escapeHtml(place.name)} on the map">
      <span class="split-row-thumb">${place.image ? `<img src="${escapeHtml(place.image)}" alt="" loading="lazy" draggable="false" onerror="this.style.display='none'">` : SPLIT_PLACEHOLDER_SVG}</span>
      <span class="split-row-text">
        <span class="split-row-title"><span class="split-row-name">${escapeHtml(place.name)}</span>${inList ? `<span class="split-row-bookmark" title="In My attractions">${MYLIST_PIN_BADGE_SVG.replace('fill="#fff"', 'fill="currentColor"')}</span>` : ''}</span>
        <span class="split-row-meta">
          <span class="split-row-dot" style="background:${color}"></span>
          <span>${escapeHtml(categoryLabel(place.category))}</span>
          ${priceText ? `<span>· ${priceText}</span>` : ''}
          ${located ? '' : '<span class="split-row-noloc">· No location</span>'}
        </span>
      </span>
    </button>
    <button type="button" class="icon-only-btn split-row-route" title="Start route here" aria-label="Start route here">${SPLIT_ROUTE_ICON_SVG}</button>
    ${gmapsUrl ? `<a class="icon-only-btn split-row-gmaps" href="${gmapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps" aria-label="Open ${escapeHtml(place.name)} in Google Maps">${SPLIT_EXTERNAL_ICON_SVG}</a>` : ''}
    ${place.desc ? `<button type="button" class="icon-only-btn split-row-details" title="View insider tips" aria-label="View insider tips for ${escapeHtml(place.name)}">${SPLIT_INFO_ICON_SVG}</button>` : ''}`;

  const main = row.querySelector('.split-row-main');
  main.addEventListener('click', () => showOnMap(place.id, { scroll: false }));
  row.addEventListener('mouseenter', () => highlightPin(place.id, true));
  row.addEventListener('mouseleave', () => highlightPin(place.id, false));
  main.addEventListener('focus', () => highlightPin(place.id, true));
  main.addEventListener('blur', () => highlightPin(place.id, false));
  const routeBtn = row.querySelector('.split-row-route');
  if (routeBtn) routeBtn.addEventListener('click', (e) => { e.stopPropagation(); tourPick(place.id); });
  const det = row.querySelector('.split-row-details');
  if (det) det.addEventListener('click', (e) => { e.stopPropagation(); openDetailModal(place.id); });
  return row;
}

// List on the left, map on the right (stacked on phones). Reuses renderMapView.
function renderSplitView(container, visible) {
  const mapPlaces = getMapPlaces(visible);
  const wrap = document.createElement('div');
  wrap.className = 'split-view';

  const listEl = document.createElement('div');
  listEl.className = 'split-list';
  listEl.setAttribute('aria-label', 'Stops - select one to fly to it on the map');
  const head = document.createElement('div');
  head.className = 'split-list-head';
  head.textContent = `${mapPlaces.length} stop${mapPlaces.length !== 1 ? 's' : ''} · click one to fly to it`;
  listEl.appendChild(head);
  mapPlaces.forEach(p => listEl.appendChild(buildSplitRow(p)));
  reorderSplitList(listEl); // if a route is already underway, open the list in that order instead of trip order

  const mapHost = document.createElement('div');
  mapHost.className = 'split-map';
  wrap.appendChild(listEl);
  wrap.appendChild(mapHost);
  container.appendChild(wrap);       // attach first: MapLibre wants a laid-out container
  renderMapView(mapHost, visible);
}

// Reorders the existing split-list rows to follow the route helper (nearest.js):
// stops already on the route first, in route order, then every remaining stop
// sorted nearest-first from the last route stop. Called whenever the route
// changes (via decorateSplitRows in nearest.js) so the list stays in sync with
// "closest next" without rebuilding the map. No-op if there's no active route,
// no split list on screen, or nearest.js hasn't loaded.
function reorderSplitList(listEl) {
  const list = listEl || document.querySelector('.split-list');
  if (!list) return;
  if (typeof tourIds === 'undefined' || tourIds.length === 0) return;
  if (typeof findPlace !== 'function' || typeof hasCoords !== 'function' || typeof tourLegKm !== 'function') return;

  const rows = [...list.querySelectorAll('.split-row')];
  if (rows.length < 2) return;

  const rowById = new Map(rows.map(r => [r.dataset.id, r]));
  const inRoute = tourIds.filter(id => rowById.has(id));
  const rest = rows.filter(r => !tourIds.includes(r.dataset.id));

  const cur = findPlace(tourIds[tourIds.length - 1]);
  let restOrdered = rest;
  if (hasCoords(cur)) {
    restOrdered = rest
      .map(row => {
        const p = findPlace(row.dataset.id);
        const km = (p && hasCoords(p)) ? tourLegKm(cur, p) : Infinity;
        return { row, km };
      })
      .sort((a, b) => a.km - b.km)
      .map(x => x.row);
  }

  // Moving each row to the end of the list re-orders them in place (the
  // sticky head isn't a .split-row, so it's never touched or displaced).
  [...inRoute.map(id => rowById.get(id)), ...restOrdered].forEach(row => list.appendChild(row));
}

function renderMapView(container, visible) {
  const renderId = ++mapRenderId;

  // getVisiblePlaces() leaves shortlisted stops out (they live in the "My
  // attractions" section), but they still belong on the map, so add them back.
  // Like that section, they ignore the search box and category filter.
  visible = getMapPlaces(visible);
  selectedMapId = null;
  mapAutoFit = true;

  if (maplibreMap) { maplibreMap.remove(); maplibreMap = null; }
  if (mapResizeObserver) { mapResizeObserver.disconnect(); mapResizeObserver = null; }
  markerById = {};
  pendingGeocodeIds = new Set();
  failedGeocodeIds = new Set();

  const wrap = document.createElement('div');
  wrap.className = 'map-view-wrap';

  const mapEl = document.createElement('div');
  mapEl.id = 'maplibreMapEl';
  mapEl.className = 'map-view-canvas';
  wrap.appendChild(mapEl);

  unlocatedPanelEl = document.createElement('div');
  unlocatedPanelEl.className = 'map-unlocated-panel';
  unlocatedPanelEl.style.display = 'none';
  wrap.appendChild(unlocatedPanelEl);

  container.appendChild(wrap);

  if (typeof maplibregl === 'undefined') {
    wrap.innerHTML = `<div class="empty-state">
      <p class="lead">Map couldn't load</p>
      <p>The MapLibre GL library didn't load — check your connection and refresh the page.</p>
    </div>`;
    return;
  }

  buildMapControls(visible, wrap, mapEl);
  if (typeof buildTourPanel === 'function') buildTourPanel(wrap, mapEl); // route helper panel (nearest.js)

  maplibreMap = new maplibregl.Map({
    container: mapEl,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [0, 20],
    zoom: 1.5,
    attributionControl: true
  });
  maplibreMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  if (typeof tourOnMapCreated === 'function') tourOnMapCreated(maplibreMap); // draws the route line once the style loads (nearest.js)
  // Once the user pans/zooms themselves, stop auto-fitting when late geocodes land.
  ['dragstart', 'zoomstart', 'rotatestart'].forEach(ev =>
    maplibreMap.on(ev, (e) => { if (e.originalEvent) mapAutoFit = false; }));

  // Zoom-dependent labels: pin names only show from LABEL_MIN_ZOOM up (or on
  // hover / selection, see styles.css) so the zoomed-out map isn't a wall of text.
  const syncLabels = () => mapEl.classList.toggle('map-labels-hidden', maplibreMap.getZoom() < LABEL_MIN_ZOOM);
  maplibreMap.on('zoom', syncLabels);
  syncLabels();

  // The container was only just appended a moment ago, so MapLibre's first
  // internal size measurement can land before the browser has actually laid
  // it out. resize() re-measures once it's really on screen; the
  // ResizeObserver keeps that correct if the panel resizes later.
  requestAnimationFrame(() => { if (maplibreMap) maplibreMap.resize(); });
  if (typeof ResizeObserver !== 'undefined') {
    mapResizeObserver = new ResizeObserver(() => { if (maplibreMap) maplibreMap.resize(); });
    mapResizeObserver.observe(mapEl);
  }

  unresolvedIds = [];

  const placeMarkers = () => {
    visible.forEach(place => {
      if (typeof place.lat === 'number' && typeof place.lng === 'number') {
        addOrUpdateMarker(place);
      } else if (place.address) {
        unresolvedIds.push(place.id);
      }
    });
    if (mapAutoFit) fitToMarkers();
    tryPendingFocus();
    renderUnlocatedPanel();

    // Geocode every address-only stop, one at a time (queueGeocode enforces
    // the gap between requests) so a big trip doesn't hammer Nominatim.
    unresolvedIds.forEach(id => {
      const place = places.find(p => p.id === id);
      if (place && !permanentlyFailed.has(failKey(place))) geocodeAndPlace(place, renderId);
    });
  };

  // Markers can be added before the style has finished loading, but it's
  // simpler and more reliable to wait for `load` once per map instance.
  if (maplibreMap.isStyleLoaded()) placeMarkers();
  else maplibreMap.once('load', placeMarkers);
}

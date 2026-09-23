/* ============ Route helper: pick a start, then always go to the closest next stop ============ */
// How it works:
//   1. The person chooses a starting stop (from the dropdown in the panel above the
//      map, or "Start route here" in a pin popup / split-list row).
//   2. The panel then shows the closest not-yet-visited stops from where they are.
//      Clicking one adds it to the route, flies the map to it, and recalculates from
//      there - "nearest neighbour", one step at a time.
//   3. The route is drawn on the map with numbered pins. It can be auto-completed,
//      opened as Google Maps walking directions, or applied as the trip's stop order.
//
// Which stops are considered? Exactly the ones currently drawn on the map: the active
// category filters, search box and "My list only" toggle all apply (see getTourPool),
// and a stop needs coordinates to take part.
//
// Distances are straight-line (haversine) x TOUR_STREET_FACTOR. Manhattan's grid makes
// real walking routes roughly 30% longer than the crow flies; this keeps ranking sensible
// without calling a routing service. Legs that would take more than TOUR_MAX_WALK_MIN
// on foot are labelled "drive / transit" instead of showing a silly walking time.
//
// Plain (non-module) script sharing globals with app.js and map-view.js:
//   - Used from app.js: places, persistPlaces, renderPlaces, escapeHtml, showToast,
//     showUndoToast, announce, categoryDotColor, undoSnapshot, isInMyList.
//   - Used from map-view.js: markerById, maplibreMap, currentMapPlaces, mapAutoFit,
//     isPlaceHiddenOnMap, flyToPlace, buildPopupHtml, MYLIST_PIN_BADGE_SVG.
//   - Called from map-view.js: buildTourPanel, tourOnMapCreated, tourPopupHtml,
//     decorateTourMarker, decorateSplitRows, refreshTour.
//   - Called from inline onclick handlers: startTour, addToTour, undoTourStep,
//     clearTour, autoCompleteTour, applyTourOrder, startTourFromSelect, tourPick.

/* ---- Tunables ---- */
const TOUR_STREET_FACTOR = 1.3;   // straight-line -> rough street distance
const TOUR_WALK_KMH = 4.8;        // average walking pace
const TOUR_MAX_WALK_MIN = 75;     // beyond this a leg is shown as "drive / transit"
const TOUR_SUGGESTIONS = 3;       // how many "closest next" options to list
const TOUR_GMAPS_MAX = 11;        // Google Maps URLs take an origin, a destination and 9 waypoints
const KM_PER_MILE = 1.609344;

// Coordinates that were saved wrongly in earlier data. Applied once when the map opens,
// and only if the stop is more than 3 km from where it should be (so a hand-corrected
// pin is never overwritten).
const COORD_FIXES = [
  { name: 'Central Park', lat: 40.7829, lng: -73.9654 } // was saved up in Westchester
];

const TOUR_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/* ---- State ---- */
let tourIds = [];            // ordered stop ids; the first one is the chosen start
let tourSuggestedId = null;  // the single closest next stop (gets the pulsing pin)
let tourPanelEl = null;      // dropdown under the Route button (start box / full route list)
let tourPanelHtmlCache = '';
let tourBtnEl = null;        // the Route button on the map
let tourCardEl = null;       // compact card at the bottom of the map while a route is running
let tourCardHtmlCache = '';
let tourCardCollapsed = false;
let tourMapReady = false;    // true once the current MapLibre style has loaded

/* ---- Small helpers ---- */
function hasCoords(p) { return !!p && typeof p.lat === 'number' && typeof p.lng === 'number'; }
function tourIndexOf(id) { return tourIds.indexOf(id); }
function findPlace(id) { return places.find(p => p.id === id); }
function getTourPlaces() { return tourIds.map(findPlace).filter(Boolean); }

// Drops route entries whose stop was deleted, edited so it lost its coordinates, or replaced
// wholesale (import, reset, trip switch).
function pruneTour() {
  tourIds = tourIds.filter(id => hasCoords(findPlace(id)));
}

function tourDistanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function tourLegKm(a, b) { return tourDistanceKm(a, b) * TOUR_STREET_FACTOR; }
function tourWalkMin(km) { return Math.max(1, Math.round(km / TOUR_WALK_KMH * 60)); }
function tourFmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// "0.4 mi · 8 min walk" (or the short form "0.4 mi · 8 min" for tight spaces).
// "≈" marks legs where either end is only a neighbourhood/ZIP-level guess.
function tourFmtLeg(a, b, short) {
  const km = tourLegKm(a, b);
  const miles = km / KM_PER_MILE;
  const approx = (a.approxLocation || b.approxLocation) ? '≈ ' : '';
  const dist = miles < 0.1 ? `${Math.max(10, Math.round(km * 3280.84 / 10) * 10)} ft` : `${miles.toFixed(1)} mi`;
  const mins = tourWalkMin(km);
  let time;
  if (mins > TOUR_MAX_WALK_MIN) time = short ? 'drive' : 'drive / transit';
  else time = short ? tourFmtMinutes(mins) : `${tourFmtMinutes(mins)} walk`;
  return `${approx}${dist} · ${time}`;
}

/* ---- Which stops can be suggested ---- */
// The stops drawn on the map right now (filters, search and "My list only" all apply).
function getTourPool() {
  const base = (typeof currentMapPlaces !== 'undefined' && currentMapPlaces.length) ? currentMapPlaces : places;
  return base.filter(p => !isPlaceHiddenOnMap(p));
}
function getTourCandidates() {
  return getTourPool().filter(p => hasCoords(p) && !tourIds.includes(p.id));
}

// The closest `count` unvisited stops to the last stop on the route, nearest first.
function getSuggestions(count) {
  const cur = findPlace(tourIds[tourIds.length - 1]);
  if (!hasCoords(cur)) return [];
  return getTourCandidates()
    .map(p => ({ place: p, km: tourLegKm(cur, p) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}

function updateSuggestion() {
  const first = tourIds.length ? getSuggestions(1)[0] : null;
  tourSuggestedId = first ? first.place.id : null;
}

/* ---- Route actions ---- */
function startTour(id) {
  const p = findPlace(id);
  if (!p) return;
  if (!hasCoords(p)) { showToast("That stop hasn't been located on the map yet"); return; }
  tourIds = [id];
  toggleTourPanel(false);
  refreshTour();
  flyToPlace(id);
  announce(`Route started at ${p.name}`);
}

function addToTour(id) {
  if (tourIds.length === 0) { startTour(id); return; }
  if (tourIds.includes(id)) { flyToPlace(id); return; }
  const p = findPlace(id);
  if (!p) return;
  if (!hasCoords(p)) { showToast("That stop hasn't been located on the map yet"); return; }
  tourIds.push(id);
  refreshTour();
  flyToPlace(id);
  announce(`${p.name} added as stop ${tourIds.length}`);
}

// Popup and list buttons use this: the first pick starts the route, later picks extend it.
function tourPick(id) { if (tourIds.length === 0) startTour(id); else addToTour(id); }

// Resolves the typed text against the located, not-yet-routed stops: an
// exact name match wins (what picking a datalist suggestion produces), and
// a partial/case-insensitive match is the fallback for someone who typed
// part of a name and hit Enter or the button without opening the list.
function startTourFromSelect() {
  const input = document.getElementById('tourStartInput');
  const query = input ? input.value.trim() : '';
  if (!query) { showToast('Choose a starting stop first'); return; }
  const pool = getTourPool().filter(hasCoords);
  const lower = query.toLowerCase();
  const match = pool.find(p => (p.name || '').toLowerCase() === lower) ||
    pool.find(p => (p.name || '').toLowerCase().includes(lower));
  if (!match) { showToast("Couldn't find that stop — pick one from the suggestions"); return; }
  startTour(match.id);
}

function undoTourStep() {
  if (tourIds.length === 0) return;
  tourIds.pop();
  refreshTour();
  const last = tourIds[tourIds.length - 1];
  if (last) flyToPlace(last);
}

function clearTour() {
  tourIds = [];
  refreshTour();
}

// Keeps going to the closest unvisited stop until none are left.
function autoCompleteTour() {
  if (tourIds.length === 0) return;
  const pool = getTourCandidates();
  if (pool.length === 0) { showToast('No more located stops to add'); return; }
  if (pool.length > 15 && !window.confirm(`Add the remaining ${pool.length} stops, always going to the closest one next?`)) return;
  let cur = findPlace(tourIds[tourIds.length - 1]);
  let added = 0;
  while (pool.length) {
    let bestIdx = 0, bestKm = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const km = tourLegKm(cur, pool[i]);
      if (km < bestKm) { bestKm = km; bestIdx = i; }
    }
    cur = pool.splice(bestIdx, 1)[0];
    tourIds.push(cur.id);
    added++;
  }
  refreshTour();
  fitTourBounds();
  showToast(`Added ${added} stop${added !== 1 ? 's' : ''} to the route`);
}

// Moves the route's stops to the top of the trip, in route order. Everything else keeps its
// relative order underneath. Undoable through the usual toast.
async function applyTourOrder() {
  const ordered = getTourPlaces();
  if (ordered.length < 2) { showToast('Add at least two stops first'); return; }
  const inRoute = new Set(ordered.map(p => p.id));
  undoSnapshot = JSON.stringify(places);
  places = [...ordered, ...places.filter(p => !inRoute.has(p.id))];
  renderPlaces();
  await persistPlaces();
  showUndoToast(`Trip order updated to your ${ordered.length}-stop route`);
}

function tourGoogleMapsUrl() {
  const list = getTourPlaces().filter(hasCoords).slice(0, TOUR_GMAPS_MAX);
  if (list.length < 2) return null;
  const fmt = p => `${p.lat},${p.lng}`;
  const origin = list[0], dest = list[list.length - 1];
  const waypoints = list.slice(1, -1).map(fmt).join('|');
  return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${encodeURIComponent(fmt(origin))}&destination=${encodeURIComponent(fmt(dest))}${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}`;
}

/* ---- Refresh everything that shows route state ---- */
function refreshTour() {
  pruneTour();
  updateSuggestion();
  renderTourPanel();
  decorateAllTourMarkers();
  decorateSplitRows();
  drawTourRoute();
}

/* ---- Panel ---- */
function repairKnownCoords() {
  let changed = false;
  COORD_FIXES.forEach(fix => {
    places.forEach(p => {
      if (p.name === fix.name && hasCoords(p) && tourDistanceKm(p, fix) > 3) {
        p.lat = fix.lat; p.lng = fix.lng; delete p.approxLocation;
        changed = true;
      }
    });
  });
  return changed;
}

// Called from renderMapView() after the map's filter control is built, before the map exists.
// The Route button + dropdown live in that control (top-left of the map). The running route's
// card sits at the bottom of the map and is attached by tourMountOnMap() once MapLibre is set up.
function buildTourPanel(wrap, mapEl) {
  if (repairKnownCoords()) persistPlaces();
  tourPanelHtmlCache = ''; tourCardHtmlCache = '';
  tourBtnEl = document.createElement('button');
  tourBtnEl.type = 'button';
  tourBtnEl.className = 'icon-text-btn map-route-btn';
  tourBtnEl.setAttribute('aria-haspopup', 'true');
  tourBtnEl.setAttribute('aria-expanded', 'false');
  tourBtnEl.title = 'Route helper: plan a walking route, always to the closest next stop';
  tourBtnEl.innerHTML = `${TOUR_ICON_SVG} Route <span class="map-filter-badge" style="display:none"></span>`;
  tourBtnEl.addEventListener('click', () => toggleTourPanel());
  tourPanelEl = document.createElement('div');
  tourPanelEl.className = 'map-route-panel';
  tourPanelEl.setAttribute('role', 'region');
  tourPanelEl.setAttribute('aria-label', 'Route helper');
  tourCardEl = document.createElement('div');
  tourCardEl.className = 'tour-card' + (tourCardCollapsed ? ' collapsed' : '');
  tourCardEl.setAttribute('role', 'region');
  tourCardEl.setAttribute('aria-label', 'Your route');
  tourCardEl.style.display = 'none';
  if (mapControlsEl) {
    const fb = mapControlsEl.querySelector('.map-filter-btn');
    if (fb) fb.after(tourBtnEl); else mapControlsEl.prepend(tourBtnEl);
    mapControlsEl.appendChild(tourPanelEl);
  }
  pruneTour();
  updateSuggestion();
  renderTourPanel();
  decorateSplitRows();
}

function tourMountOnMap(mapEl) { if (tourCardEl) mapEl.appendChild(tourCardEl); }

function toggleTourPanel(open) {
  if (!tourPanelEl || !tourBtnEl) return;
  const shouldOpen = open !== undefined ? open : !tourPanelEl.classList.contains('open');
  if (shouldOpen && typeof toggleMapFilterPanel === 'function') toggleMapFilterPanel(false);
  tourPanelEl.classList.toggle('open', shouldOpen);
  tourBtnEl.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) setTimeout(() => { const i = tourPanelEl.querySelector('#tourStartInput'); if (i) i.focus(); }, 0);
}

function toggleTourCard() {
  tourCardCollapsed = !tourCardCollapsed;
  if (tourCardEl) tourCardEl.classList.toggle('collapsed', tourCardCollapsed);
}

function renderTourPanel() {
  if (!tourPanelEl) return;

  const pool = getTourPool();
  const located = pool.filter(hasCoords);
  const unlocated = pool.filter(p => !hasCoords(p) && p.address && p.address.trim()).length;
  const unlocatedNote = unlocated
    ? `<p class="tour-note">${unlocated} stop${unlocated !== 1 ? 's don\'t' : ' doesn\'t'} have a map location yet, so ${unlocated !== 1 ? 'they\'re' : 'it\'s'} left out of the suggestions. They\'ll be included as soon as they\'re located.</p>`
    : '';

  const tourPlaces = getTourPlaces();
  if (tourBtnEl) {
    tourBtnEl.classList.toggle('active', tourPlaces.length > 0);
    const badge = tourBtnEl.querySelector('.map-filter-badge');
    if (badge) { badge.textContent = tourPlaces.length; badge.style.display = tourPlaces.length ? '' : 'none'; }
  }

  let panelHtml, cardHtml = '';

  if (tourPlaces.length === 0) {
    // Searchable text input (backed by a <datalist>): the browser filters suggestions as you type.
    const sortedLocated = located.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const dataOptions = sortedLocated.map(p => `<option value="${escapeHtml(p.name)}"></option>`).join('');
    panelHtml = `
      <div class="tour-head">
        <div class="tour-title">${TOUR_ICON_SVG}Route helper</div>
        <span class="tour-summary">${located.length} located stop${located.length !== 1 ? 's' : ''} to choose from</span>
      </div>
      <p class="tour-lead">Choose where you're starting. You'll then see the closest stop to go to next, so you don't cross the city for one attraction.</p>
      <div class="tour-start-row">
        <input type="text" id="tourStartInput" list="tourStartOptions" aria-label="Starting stop" placeholder="Search a starting stop…" autocomplete="off" onkeydown="if(event.key==='Enter'){event.preventDefault(); startTourFromSelect();}">
        <datalist id="tourStartOptions">${dataOptions}</datalist>
        <button type="button" class="icon-text-btn tour-primary" onclick="startTourFromSelect()">Start route</button>
      </div>
      <p class="tour-hint">You can also click a pin or a list row and choose "Start route here".</p>
      ${unlocatedNote}`;
  } else {
    const cur = tourPlaces[tourPlaces.length - 1];
    const sugg = getSuggestions(TOUR_SUGGESTIONS);
    const legs = tourPlaces.slice(1).map((p, i) => tourLegKm(tourPlaces[i], p));
    const totalKm = legs.reduce((s, k) => s + k, 0);
    const allWalkable = legs.every(k => tourWalkMin(k) <= TOUR_MAX_WALK_MIN);
    let summary = `${tourPlaces.length} stop${tourPlaces.length !== 1 ? 's' : ''}`;
    if (legs.length) {
      summary += ` · ${(totalKm / KM_PER_MILE).toFixed(1)} mi`;
      if (allWalkable) summary += ` · about ${tourFmtMinutes(legs.reduce((s, k) => s + tourWalkMin(k), 0))} walking`;
    }

    const gmaps = tourGoogleMapsUrl();
    const gmapsTitle = tourPlaces.length > TOUR_GMAPS_MAX
      ? `Google Maps takes ${TOUR_GMAPS_MAX} stops at most, so this opens the first ${TOUR_GMAPS_MAX}`
      : 'Open this route as walking directions in Google Maps';

    const suggestHtml = sugg.length
      ? `<div class="tour-suggest-list">${sugg.map((s, i) => `
          <button type="button" class="tour-suggest${i === 0 ? ' is-closest' : ''}" onclick="addToTour('${s.place.id}')" title="Add to the route and go there">
            <span class="tour-suggest-name"><span class="tour-suggest-dot" style="background:${categoryDotColor(s.place.category) || 'var(--accent)'}"></span>${escapeHtml(s.place.name)}</span>
            <span class="tour-suggest-meta">${i === 0 ? '<span class="tour-closest-tag">Closest</span>' : ''}${escapeHtml(tourFmtLeg(cur, s.place))}</span>
          </button>`).join('')}</div>`
      : `<p class="tour-note">${getTourPool().some(p => hasCoords(p)) ? 'Every located stop on the map is now on your route.' : 'No other located stops on the map.'} Change the map filters to widen the choice.</p>`;

    // Full route list lives in the dropdown so it doesn't crowd the map.
    panelHtml = `
      <div class="tour-head">
        <div class="tour-title">${TOUR_ICON_SVG}Your route</div>
        <span class="tour-summary">${escapeHtml(summary)}</span>
      </div>
      <ol class="tour-route" aria-label="Your route so far">${tourPlaces.map((p, i) => `
        <li><button type="button" class="tour-stop" onclick="flyToPlace('${p.id}')" title="Show on map">
          <span class="tour-stop-num">${i + 1}</span><span class="tour-stop-name">${escapeHtml(p.name)}</span>${i > 0 ? `<span class="tour-stop-leg">${escapeHtml(tourFmtLeg(tourPlaces[i - 1], p, true))}</span>` : ''}
        </button></li>`).join('')}</ol>
      ${unlocatedNote}`;

    // Compact card on the map: where you are, the closest next stops, and the route actions.
    cardHtml = `
      <div class="tour-card-head">
        <p class="tour-now">You're at <strong>${tourPlaces.length}. ${escapeHtml(cur.name)}</strong><span class="tour-summary"> · ${escapeHtml(summary)}</span></p>
        <button type="button" class="icon-only-btn tour-card-toggle" onclick="toggleTourCard()" title="Collapse / expand" aria-label="Collapse or expand the route card">
          <svg width="14" height="14" viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="tour-card-body">
        ${sugg.length ? '<div class="tour-card-label">Closest next</div>' : ''}
        ${suggestHtml}
        <div class="tour-actions">
          <button type="button" class="icon-text-btn" onclick="undoTourStep()">Undo last</button>
          <button type="button" class="icon-text-btn" onclick="autoCompleteTour()"${sugg.length ? '' : ' disabled'} title="Keep going to the closest stop until none are left">Auto-complete</button>
          ${gmaps ? `<a class="icon-text-btn" href="${gmaps}" target="_blank" rel="noopener" title="${escapeHtml(gmapsTitle)}">Walking directions ↗</a>` : ''}
          <button type="button" class="icon-text-btn" onclick="applyTourOrder()"${tourPlaces.length < 2 ? ' disabled' : ''} title="Move these stops to the top of your trip, in this order">Use as trip order</button>
          <button type="button" class="icon-text-btn danger" onclick="clearTour()">Clear</button>
        </div>
      </div>`;
  }

  // The card is cheap to rebuild and holds no typed input.
  if (tourCardEl && cardHtml !== tourCardHtmlCache) {
    tourCardHtmlCache = cardHtml;
    tourCardEl.innerHTML = cardHtml;
    tourCardEl.style.display = cardHtml ? '' : 'none';
  }

  // Never rebuild the dropdown while the start box is in use, or typed text would vanish.
  if (panelHtml === tourPanelHtmlCache) return;
  const active = document.activeElement;
  if (active && active.id === 'tourStartInput' && tourPanelEl.contains(active)) return;
  const prevInput = tourPanelEl.querySelector('#tourStartInput');
  const prevValue = prevInput ? prevInput.value : '';
  tourPanelHtmlCache = panelHtml;
  tourPanelEl.innerHTML = panelHtml;
  const nextInput = tourPanelEl.querySelector('#tourStartInput');
  if (nextInput && prevValue) nextInput.value = prevValue;
}

/* ---- Map pins ---- */
// Called when a pin is created (map-view.js addOrUpdateMarker) and whenever the route changes.
// Updates the pin in place, so open popups aren't closed by a re-render.
function decorateTourMarker(place, refreshPopup) {
  const marker = markerById[place.id];
  if (!marker) return;
  const el = marker.getElement();
  const idx = tourIndexOf(place.id);
  el.classList.toggle('is-tour', idx >= 0);
  el.classList.toggle('is-suggested', place.id === tourSuggestedId);
  const dot = el.querySelector('.map-pin-dot');
  if (dot) dot.innerHTML = idx >= 0
    ? `<span class="map-pin-num">${idx + 1}</span>`
    : (isInMyList(place.id) ? MYLIST_PIN_BADGE_SVG : '');
  if (refreshPopup) {
    const popup = marker.getPopup();
    if (popup) popup.setHTML(buildPopupHtml(place));
  }
}

function decorateAllTourMarkers() {
  Object.keys(markerById).forEach(id => {
    const p = findPlace(id);
    if (p) decorateTourMarker(p, true);
  });
}

// Extra lines inside a pin's popup: start/add button, or its position in the route.
function tourPopupHtml(place) {
  if (!hasCoords(place)) return '';
  const idx = tourIndexOf(place.id);
  if (idx >= 0) return `<div class="map-popup-tour">Stop ${idx + 1} of ${tourIds.length} on your route</div>`;
  if (tourIds.length === 0) {
    return `<button type="button" class="map-popup-route" onclick="startTour('${place.id}')">Start route here</button>`;
  }
  const cur = findPlace(tourIds[tourIds.length - 1]);
  const closest = place.id === tourSuggestedId;
  return `<button type="button" class="map-popup-route" onclick="addToTour('${place.id}')">Add as next stop</button>
    <div class="map-popup-leg">${closest ? 'Closest to your last stop · ' : ''}${hasCoords(cur) ? escapeHtml(tourFmtLeg(cur, place)) + ` from stop ${tourIds.length}` : ''}</div>`;
}

/* ---- Route line on the map ---- */
// Called from renderMapView right after a new map is created.
function tourOnMapCreated(map) {
  tourMapReady = false;
  const ready = () => { tourMapReady = true; drawTourRoute(); };
  if (map.isStyleLoaded()) ready(); else map.once('load', ready);
}

// A solid teal line through the route, plus a faint dashed preview to the suggested next stop.
function drawTourRoute() {
  if (!maplibreMap || !tourMapReady) return;
  const features = [];
  const pts = getTourPlaces().filter(hasCoords);
  if (pts.length >= 2) {
    features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) } });
  }
  const next = tourSuggestedId ? findPlace(tourSuggestedId) : null;
  if (pts.length && hasCoords(next)) {
    const last = pts[pts.length - 1];
    features.push({ type: 'Feature', properties: { kind: 'next' }, geometry: { type: 'LineString', coordinates: [[last.lng, last.lat], [next.lng, next.lat]] } });
  }
  const data = { type: 'FeatureCollection', features };
  const source = maplibreMap.getSource('tour-route');
  if (source) { source.setData(data); return; }
  maplibreMap.addSource('tour-route', { type: 'geojson', data });
  maplibreMap.addLayer({
    id: 'tour-route-casing', type: 'line', source: 'tour-route', filter: ['==', ['get', 'kind'], 'route'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 }
  });
  maplibreMap.addLayer({
    id: 'tour-route-line', type: 'line', source: 'tour-route', filter: ['==', ['get', 'kind'], 'route'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#0d9488', 'line-width': 4 }
  });
  maplibreMap.addLayer({
    id: 'tour-next-line', type: 'line', source: 'tour-route', filter: ['==', ['get', 'kind'], 'next'],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': '#0b7d72', 'line-width': 3, 'line-opacity': 0.7, 'line-dasharray': [1.5, 1.5] }
  });
}

function fitTourBounds() {
  const pts = getTourPlaces().filter(hasCoords);
  if (!maplibreMap || pts.length === 0) return;
  const bounds = pts.reduce((b, p) => b.extend([p.lng, p.lat]),
    new maplibregl.LngLatBounds([pts[0].lng, pts[0].lat], [pts[0].lng, pts[0].lat]));
  mapAutoFit = false; // don't let late geocodes pull the camera away
  maplibreMap.fitBounds(bounds, { padding: { top: 70, left: 70, right: 70, bottom: 170 }, maxZoom: 15, animate: true });
}

/* ---- Split-view list rows ---- */
// Adds the route number and, once a route is running, each stop's distance from the last stop.
function decorateSplitRows() {
  const rows = document.querySelectorAll('.split-row');
  if (!rows.length) return;
  const cur = findPlace(tourIds[tourIds.length - 1]);
  rows.forEach(row => {
    const id = row.dataset.id;
    const idx = tourIndexOf(id);
    row.classList.toggle('in-tour', idx >= 0);
    row.classList.toggle('is-next', id === tourSuggestedId);

    const title = row.querySelector('.split-row-title');
    if (title) {
      const old = title.querySelector('.split-row-tournum');
      if (old) old.remove();
      if (idx >= 0) title.insertAdjacentHTML('afterbegin', `<span class="split-row-tournum">${idx + 1}</span>`);
    }

    const meta = row.querySelector('.split-row-meta');
    if (meta) {
      const oldDist = meta.querySelector('.split-row-dist');
      if (oldDist) oldDist.remove();
      const p = findPlace(id);
      if (idx < 0 && hasCoords(cur) && hasCoords(p)) {
        meta.insertAdjacentHTML('beforeend', `<span class="split-row-dist">· ${escapeHtml(tourFmtLeg(cur, p, true))}</span>`);
      }
    }

    const btn = row.querySelector('.split-row-route');
    if (btn) {
      const name = (findPlace(id) || {}).name || 'this stop';
      let label;
      if (idx >= 0) label = `${name} is stop ${idx + 1} on your route`;
      else if (tourIds.length === 0) label = `Start route at ${name}`;
      else label = `Add ${name} as the next stop`;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.classList.toggle('active', idx >= 0);
    }
  });

  // Keep the split-list's on-screen order following the route (route stops
  // first, then closest-next), instead of just decorating rows in place.
  if (typeof reorderSplitList === 'function') reorderSplitList();
}

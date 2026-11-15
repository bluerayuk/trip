/* ============ Quick add: paste Google Maps links or place names ============ */
// Paste one or more lines into the "Quick add" box at the top of the Add panel.
//   - full Google Maps link  -> name + exact pin from the link, address + category looked up
//   - plain place name       -> searched (Photon / OpenStreetMap), best match used
//   - one line               -> fills the form so you can review it, then press Add stop
//   - several lines          -> shows what it found and adds them all as new stops (with Undo)
//   - a business with several locations (a chain, or several pasted links for the same name) becomes ONE stop
//     with extra locations, and new branches are attached to a stop already on the trip instead of duplicating it
// Shortened links (maps.app.goo.gl) can't be followed from a browser, so those are reported, not guessed.
// Plain script: load AFTER maps-link.js and BEFORE app.js. Uses showToast, showUndoToast, places, etc. at call time.

const QA_PHOTON_SEARCH = 'https://photon.komoot.io/api/';
const QA_PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
let quickAddBusy = false;

/* ---- parsing one pasted line ---- */
function qaParseLine(line) {
  const t = line.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(t)) return { kind: 'short', raw: t };
    if (!/google\.[a-z.]+\/maps|maps\.google\./i.test(t)) return { kind: 'unsupported', raw: t };
    const p = parseGoogleMapsLink(t);
    if (p) return { kind: 'coords', name: p.name, lat: p.lat, lng: p.lng, raw: t };
    // No coordinates in the link: fall back to the place text inside it (/place/NAME, /search/NAME, ?q=NAME)
    const m = t.match(/\/maps\/(?:place|search)\/([^/@?]+)/) || t.match(/[?&](?:q|query)=([^&]+)/);
    if (m) { try { return { kind: 'text', text: decodeURIComponent(m[1].replace(/\+/g, ' ')), raw: t }; } catch (e) {} }
    return { kind: 'unsupported', raw: t };
  }
  const ll = t.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);   // bare "lat, lng"
  if (ll) return { kind: 'coords', name: null, lat: parseFloat(ll[1]), lng: parseFloat(ll[2]), raw: t };
  if (/^\d.*,\s*[A-Z]{2}\s*\d{0,5}\s*$/.test(t)) return { kind: 'address', text: t, raw: t };   // "620 6th Ave, New York, NY 10011"
  return { kind: 'text', text: t, raw: t };
}

/* ---- lookups ---- */
function qaAddress(pr) {
  if (!pr) return '';
  const street = [pr.housenumber, pr.street].filter(Boolean).join(' ');
  const parts = [street, pr.city || pr.town || pr.village || pr.district, pr.state, pr.postcode].filter(Boolean);
  return parts.join(', ');
}

function qaGuessCategory(pr, name) {
  const key = pr && pr.osm_key, val = pr && pr.osm_value, n = (name || '').toLowerCase();
  if (key === 'amenity' && /^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten|bakery)$/.test(val)) return 'dining';
  if (key === 'shop' && /^(bakery|coffee|deli|pastry|seafood|wine|alcohol)$/.test(val)) return 'dining';
  if (key === 'amenity' && /^(nightclub|theatre|cinema|casino|arts_centre)$/.test(val)) return /arts/.test(val) ? 'museums-culture' : 'entertainment-nightlife';
  if (key === 'tourism' && /^(museum|gallery)$/.test(val)) return 'museums-culture';
  if (key === 'tourism' && /^(zoo|theme_park|aquarium)$/.test(val)) return 'entertainment-nightlife';
  if (key === 'tourism' && val === 'viewpoint') return 'viewpoints-photography';
  if (key === 'shop') return 'shopping';
  if (key === 'leisure' && /^(park|nature_reserve|garden|beach_resort)$/.test(val)) return 'outdoors';
  if (key === 'natural' || key === 'waterway') return 'outdoors';
  if (/\b(restaurant|cafe|coffee|pizza|diner|deli|bakery|bagel|grill|tavern|brewery|bar|pub|steakhouse|bistro|ice cream|donut|burger|taco)\b/.test(n)) return 'dining';
  if (/\b(museum|gallery|library|historic|cultural)\b/.test(n)) return 'museums-culture';
  if (/\b(park|beach|trail|lake|garden|state park|preserve|falls|island|bluff)\b/.test(n)) return 'outdoors';
  if (/\b(observation|overlook|viewpoint|lookout|rooftop)\b/.test(n)) return 'viewpoints-photography';
  if (/\b(tower|building|bridge|skyscraper|terminal|station)\b/.test(n)) return 'skyscrapers';
  if (/\b(theat(er|re)|club|casino|arcade|stadium|amusement)\b/.test(n)) return 'entertainment-nightlife';
  if (/\b(mall|market|outlet|store|shop|boutique)\b/.test(n)) return 'shopping';
  return 'sightseeing';
}

async function qaJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('lookup failed ' + res.status);
  return res.json();
}

async function qaReverse(lat, lng) {
  try {
    const data = await qaJson(`${QA_PHOTON_REVERSE}?lat=${lat}&lon=${lng}&limit=1`);
    const f = data && data.features && data.features[0];
    return f ? f.properties : null;
  } catch (e) { return null; }
}

const QA_MAX_LOCATIONS = 40;        // main location + up to 39 branches
const QA_BRANCH_RADIUS_M = 120000;  // branches must be within ~120 km of the best match
const qaKey = (n) => String(n || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const qaLabel = (pr) => (pr && (pr.district || pr.locality || pr.suburb || pr.city || pr.street)) || '';

// Best match for `text`, plus other places with the exact same name nearby (other branches of a business).
async function qaSearchAll(text) {
  const geo = (typeof getGeoContext === 'function') ? getGeoContext() : {};
  const url = `${QA_PHOTON_SEARCH}?limit=20&q=${encodeURIComponent(text)}` +
    (geo.center ? `&lat=${geo.center.lat}&lon=${geo.center.lng}` : '') +
    (geo.viewbox && geo.accept ? `&bbox=${geo.viewbox.join(',')}` : '');
  const data = await qaJson(url);
  const feats = ((data && data.features) || [])
    .filter(f => f.geometry && f.geometry.coordinates)
    .map(f => ({ props: f.properties || {}, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
    .filter(f => typeof inGeoArea !== 'function' || inGeoArea(geo, f.lat, f.lng));
  if (!feats.length) return null;
  const top = feats[0];
  const topKey = qaKey(top.props.name || text);
  const branches = [];
  for (const f of feats.slice(1)) {
    if (qaKey(f.props.name) !== topKey || !topKey) continue;
    if (/^(highway|boundary|place)$/.test(f.props.osm_key || '')) continue;
    if (qaDistM(top, f) > QA_BRANCH_RADIUS_M) continue;
    if ([top, ...branches].some(x => qaDistM(x, f) < 60)) continue;      // same spot listed twice
    branches.push(f);
    if (branches.length >= QA_MAX_LOCATIONS - 1) break;
  }
  return { top, branches };
}

// -> { name, address, label, lat, lng, category, locations: [{label,address,lat,lng}] } or { error }
async function qaResolve(item) {
  if (item.kind === 'address') {
    const shared = ((document.getElementById('placeName') || {}).value || '').trim();
    const parts = item.text.split(',').map(s => s.trim());
    const street = parts[0].replace(/\s+(?:Suite|Ste|Unit|Fl|Floor)\.?\s*[\w-]+.*$/i, '').replace(/\s+1st Floor$/i, '');
    const name = shared || street;
    const label = parts.length >= 3 ? parts[parts.length - 2] : '';       // borough / city
    let hit = null;
    try { hit = await queueGeocode({ address: item.text, name: shared }); }   // map-view.js: cleans "Ste 302A", ranges, etc.
    catch (e) { /* offline: keep the address, the map will retry */ }
    return {
      name, address: item.text, label,
      lat: hit ? hit.lat : undefined, lng: hit ? hit.lng : undefined, approx: !!(hit && hit.approx),
      category: qaGuessCategory(null, name), locations: []
    };
  }
  if (item.kind === 'coords') {
    const pr = await qaReverse(item.lat, item.lng);      // best effort: null if offline/blocked
    const name = item.name || (pr && pr.name) || `Pin ${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`;
    const addr = qaAddress(pr);
    return { name, address: addr || name, label: qaLabel(pr), lat: item.lat, lng: item.lng, category: qaGuessCategory(pr, name), locations: [] };
  }
  try {
    const hit = await qaSearchAll(item.text);
    if (!hit) return { error: `No match for "${item.text}"` };
    const pr = hit.top.props, name = pr.name || item.text;
    return {
      name, address: qaAddress(pr) || name, label: qaLabel(pr), lat: hit.top.lat, lng: hit.top.lng,
      category: qaGuessCategory(pr, name),
      locations: hit.branches.map(f => ({ label: qaLabel(f.props), address: qaAddress(f.props) || name, lat: f.lat, lng: f.lng }))
    };
  } catch (e) { return { error: `Couldn't look up "${item.text}" (offline or blocked)` }; }
}

/* ---- distance ---- */
function qaDistM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---- grouping: one stop per business, many locations ---- */
const qaLoc = (x) => { const l = { label: x.label || '', address: x.address, lat: x.lat, lng: x.lng }; if (x.approx || x.approxLocation) l.approxLocation = true; return l; };
function qaNear(entries, x) { return entries.some(e => typeof e.lat === 'number' && typeof e.lng === 'number' && qaDistM(e, x) < 60); }

// Merge resolved results that are the same business into one group: { key, r (main), extras: [locations] }.
function qaGroup(found) {
  const groups = [];
  found.forEach(r => {
    const key = qaKey(r.name);
    const all = [qaLoc(r), ...(r.locations || [])];
    const g = groups.find(x => x.key === key);
    if (!g) { groups.push({ key, r, extras: all.slice(1) }); return; }
    all.forEach(l => { if (!qaNear([g.r, ...g.extras], l) && g.extras.length < QA_MAX_LOCATIONS - 1) g.extras.push(l); });
  });
  return groups;
}

// Branches of a group that the trip doesn't have yet, if the business is already a stop.
function qaPlan(g, existingPlaces) {
  const existing = existingPlaces.find(p => qaKey(p.name) === g.key);
  if (!existing) return { existing: null, add: [g.r, ...g.extras].slice(0, QA_MAX_LOCATIONS).map(qaLoc) };
  const have = mapEntriesOf(existing);
  const add = [qaLoc(g.r), ...g.extras].filter(l => !qaNear(have, l));
  return { existing, add };
}

const qaCount = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---- main entry (button + paste) ---- */
function quickAddStatus(msg) { const el = document.getElementById('quickAddStatus'); if (el) el.textContent = msg || ''; }

async function quickAddRun() {
  if (quickAddBusy) return;
  const box = document.getElementById('quickAddInput');
  const lines = box.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { quickAddStatus('Paste a Google Maps link or a place name first.'); return; }
  // Several addresses = one business: take its name from the form (or ask once), so they all become locations of ONE stop.
  const addrCount = lines.filter(l => { const it = qaParseLine(l); return it && it.kind === 'address'; }).length;
  if (addrCount >= 2 && !document.getElementById('placeName').value.trim()) {
    const n = (window.prompt('These addresses are for one business. What is its name?') || '').trim();
    if (!n) { quickAddStatus('Type the business name first.'); return; }
    document.getElementById('placeName').value = n;
  }
  quickAddBusy = true;
  const btn = document.getElementById('quickAddBtn'); if (btn) btn.disabled = true;
  try {
    const found = [], problems = [];
    for (let i = 0; i < lines.length; i++) {
      quickAddStatus(`Looking up ${i + 1} of ${lines.length}...`);
      const item = qaParseLine(lines[i]);
      if (!item) continue;
      if (item.kind === 'short') { problems.push('A shortened maps.app.goo.gl link: open it, then copy the full link from the address bar (or type the place name)'); continue; }
      if (item.kind === 'unsupported') { problems.push(`Not a Google Maps link: ${item.raw.slice(0, 40)}`); continue; }
      const r = await qaResolve(item);
      if (r.error) problems.push(r.error); else found.push(r);
      if (i < lines.length - 1 && item.kind !== 'address') await new Promise(res => setTimeout(res, 300));   // be polite to the free geocoder
    }
    if (!found.length) { quickAddStatus(problems.join('. ') || 'Nothing found.'); return; }

    // While editing a stop, never match it against itself.
    const others = editingId ? places.filter(p => p.id !== editingId) : places;
    const groups = qaGroup(found);
    const plans = groups.map(g => ({ g, ...qaPlan(g, others) }));
    const note = problems.length ? ' Note: ' + problems.join('. ') : '';

    // ---- one business: fill the form for review (or attach to the stop already on the trip) ----
    if (plans.length === 1) {
      const { g, existing, add } = plans[0];
      if (existing) {
        if (!add.length) { quickAddStatus(`"${existing.name}" is already on this trip, including ${g.extras.length ? 'those locations' : 'that location'}.` + note); return; }
        if (!window.confirm(`"${existing.name}" is already on this trip.\n\nAdd ${qaCount(add.length, 'new location')} to it?\n` + add.map(l => `• ${l.label || l.address}`).join('\n'))) { quickAddStatus(''); return; }
        undoSnapshot = JSON.stringify(places); undoPackagesSnapshot = null; undoMyListSnapshot = null;
        existing.locations = [...(Array.isArray(existing.locations) ? existing.locations : []), ...add];
        box.value = '';
        renderPlaces(); await persistPlaces();
        showUndoToast(`${qaCount(add.length, 'location')} added to ${existing.name}`);
        quickAddStatus(note.trim());
        return;
      }
      const r = g.r;
      document.getElementById('placeName').value = r.name;
      document.getElementById('placeAddress').value = r.address;
      document.getElementById('placeCategory').value = r.category;
      pendingCoords = { lat: r.lat, lng: r.lng };
      extraLocations = g.extras.map(l => ({ ...l }));
      renderLocationInputs();
      box.value = '';
      quickAddStatus((g.extras.length ? `Found ${g.extras.length + 1} locations (extras are listed under "Other locations"; remove any you don't want). ` : 'Filled in. ') +
        'Check it, then press Add stop.' + note);
      return;
    }

    // ---- several businesses: preview, then apply ----
    const work = plans.filter(p => p.add.length);
    if (!work.length) { quickAddStatus('All of those are already on this trip.' + note); return; }
    const preview = work.map(p => p.existing
      ? `• ${p.existing.name}: +${qaCount(p.add.length, 'location')} on an existing stop`
      : `• ${p.g.r.name} (${p.add.length > 1 ? qaCount(p.add.length, 'location') : p.g.r.address})`).join('\n');
    if (!window.confirm(`Apply these changes?\n\n${preview}` + (problems.length ? `\n\nCouldn't use ${qaCount(problems.length, 'line')}.` : ''))) { quickAddStatus(''); return; }

    undoSnapshot = JSON.stringify(places); undoPackagesSnapshot = null; undoMyListSnapshot = null;
    const base = Date.now();
    let newStops = 0, newLocs = 0;
    work.forEach((p, i) => {
      if (p.existing) {
        p.existing.locations = [...(Array.isArray(p.existing.locations) ? p.existing.locations : []), ...p.add];
        newLocs += p.add.length; return;
      }
      const r = p.g.r;
      const stop = {
        id: String(base + i), name: r.name, category: r.category, day: '', website: '', address: r.address,
        summary: '', desc: '', image: null, cost: null, rating: null, packageId: null, gallery: [], lat: r.lat, lng: r.lng
      };
      if (r.approx) stop.approxLocation = true;
      if (p.g.extras.length) stop.locations = p.g.extras.slice(0, QA_MAX_LOCATIONS - 1).map(l => ({ ...l }));
      places.push(stop);
      newStops++; newLocs += stop.locations ? stop.locations.length : 0;
    });
    box.value = '';
    renderPlaces();
    await persistPlaces();
    showUndoToast(`${qaCount(newStops, 'stop')} added` + (newLocs ? `, ${qaCount(newLocs, 'extra location')}` : ''));
    quickAddStatus(problems.length ? 'Not added: ' + problems.join('. ') : '');
  } finally {
    quickAddBusy = false;
    if (btn) btn.disabled = false;
  }
}

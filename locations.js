/* ============ Multiple locations per stop ============ */
// A stop keeps its main `address` / `lat` / `lng`. Extra branches live in an
// optional `place.locations` array: [{ label, address, lat?, lng?, approxLocation? }].
//
// The map treats every location as its own "entry". The main location is the
// stop itself (id unchanged). Each extra branch is a Proxy whose id is
// `${place.id}#${index}`; reads of id / address / lat / lng / approxLocation /
// branchLabel go to the branch, everything else (name, category, desc...) falls
// through to the stop. Writes (e.g. geocoding results) land on the branch object
// inside place.locations, so they are saved with the stop.
//
// Plain script, load AFTER delta.js and BEFORE map-view.js / nearest.js / app.js.


// Cleans addresses pasted from other-language / country-first sources, e.g.
//   "United States, New York, Brooklyn, Nostrand Ave, Umi Buffet邮政编码: 11235"
//   -> "Umi Buffet, Nostrand Ave, Brooklyn, New York 11235, United States"
// Display uses this on every read; saving a stop writes the cleaned text. Normal addresses pass through unchanged.
const POSTCODE_WORD = /\s*(?:邮政编码|郵遞區號|邮编|郵便番号|우편번호)\s*[:：]?\s*([A-Za-z0-9 -]{3,10})\s*$/;
function tidyAddress(addr) {
  let s = String(addr == null ? '' : addr).trim();
  if (!s) return s;
  let post = '';
  const m = s.match(POSTCODE_WORD);
  if (m) { post = m[1].trim(); s = s.slice(0, m.index).trim(); }
  let parts = s.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length > 2 && /^(united states(?: of america)?|usa|us|美国|美國)$/i.test(parts[0])) parts = parts.reverse();  // country-first -> country-last
  if (post && parts.length >= 2 && !parts.join(',').includes(post)) parts[parts.length - 2] += ' ' + post;
  else if (post && !s.includes(post)) parts.push(post);
  return parts.join(', ');
}

const LOC_SEP = '#';
const locEntryCache = new Map(); // `${id}#${i}` -> { loc, proxy }

const baseIdOf = (id) => String(id).split(LOC_SEP)[0];

function extraLocationsOf(place) {
  return Array.isArray(place && place.locations)
    ? place.locations.filter(l => l && ((l.address && l.address.trim()) || typeof l.lat === 'number'))
    : [];
}

function makeBranchEntry(place, loc, index) {
  const vid = `${place.id}${LOC_SEP}${index}`;
  const cached = locEntryCache.get(vid);
  if (cached && cached.loc === loc && cached.base === place) return cached.proxy;
  const own = new Set(['address', 'lat', 'lng', 'approxLocation']);
  const proxy = new Proxy(place, {
    get(t, k) {
      if (k === 'id') return vid;
      if (k === 'parentId') return place.id;
      if (k === 'isBranch') return true;
      if (k === 'branchLabel') return loc.label || tidyAddress(loc.address).split(',')[0].trim();
      if (k === 'address') return tidyAddress(loc.address);
      if (own.has(k)) return loc[k];
      return t[k];
    },
    set(t, k, v) { if (own.has(k)) loc[k] = v; else t[k] = v; return true; },
    deleteProperty(t, k) { if (own.has(k)) delete loc[k]; return true; },
    has(t, k) { return own.has(k) ? k in loc : k in t; }
  });
  locEntryCache.set(vid, { loc, base: place, proxy });
  return proxy;
}

// All map entries for one stop: the stop itself, then one per extra branch.
function mapEntriesOf(place) {
  const entries = [place];
  if (Array.isArray(place.locations)) {
    place.locations.forEach((loc, i) => {
      if (loc && ((loc.address && loc.address.trim()) || typeof loc.lat === 'number')) entries.push(makeBranchEntry(place, loc, i));
    });
  }
  return entries;
}

// "Unique locations only": show each stop once (its main location) instead of one card/pin per branch.
let uniqueLocations = false;
function initUniqueLocations() {
  try { uniqueLocations = localStorage.getItem('uniqueLocations') === '1'; } catch (e) {}
  const cb = document.getElementById('uniqueLocationsToggle');
  if (cb) cb.checked = uniqueLocations;
}
function setUniqueLocations(on) {
  uniqueLocations = !!on;
  try { localStorage.setItem('uniqueLocations', uniqueLocations ? '1' : '0'); } catch (e) {}
  const cb = document.getElementById('uniqueLocationsToggle');
  if (cb) cb.checked = uniqueLocations;
  if (typeof renderFilterMenu === 'function') renderFilterMenu();
  if (typeof renderPlaces === 'function') renderPlaces();
}
function onUniqueLocationsChange() {
  const cb = document.getElementById('uniqueLocationsToggle');
  setUniqueLocations(!!(cb && cb.checked));
}

const expandMapEntries = (list) => uniqueLocations ? list : list.flatMap(mapEntriesOf);

// Like places.find(p => p.id === id), but also understands branch ids.
function findMapEntry(id) {
  if (id == null) return undefined;
  const s = String(id);
  const i = s.indexOf(LOC_SEP);
  if (i === -1) return places.find(p => p.id === s);
  const base = places.find(p => p.id === s.slice(0, i));
  if (!base || !Array.isArray(base.locations)) return undefined;
  const idx = parseInt(s.slice(i + 1), 10);
  const loc = base.locations[idx];
  return loc ? makeBranchEntry(base, loc, idx) : undefined;
}

// "Show on map" labels: "Joe's Pizza" or "Joe's Pizza - West Village"
const entryTitle = (p) => p.isBranch && p.branchLabel ? `${p.name} · ${p.branchLabel}` : p.name;

// Closest entry of a stop to a point (used by nearest-food / route suggestions).
function nearestEntryTo(place, point, distFn) {
  let best = null, bestKm = Infinity;
  mapEntriesOf(place).forEach(e => {
    if (typeof e.lat !== 'number' || typeof e.lng !== 'number') return;
    const km = distFn(point, e);
    if (km < bestKm) { bestKm = km; best = e; }
  });
  return best ? { entry: best, km: bestKm } : null;
}

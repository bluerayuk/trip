/* ============ Delta: store only what differs from the baked-in sample ============ */
// base 'sample' = SAMPLE_PLACES/SAMPLE_PACKAGES (the default trip); 'none' = empty (other trips).
// Plain script: load AFTER sample-packages.js and BEFORE app.js.
const DELTA_FORMAT = 'delta-v2';
const clone = x => JSON.parse(JSON.stringify(x));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function deltaBase(base) {
  return base === 'sample'
    ? { places: clone(SAMPLE_PLACES), packages: clone(SAMPLE_PACKAGES) }
    : { places: [], packages: [] };
}

function computeDelta(places, packages, myList, base) {
  const b = deltaBase(base);
  const baseMap = new Map(b.places.map(p => [p.id, p]));
  const curIds = new Set(places.map(p => p.id));

  const added = places.filter(p => !baseMap.has(p.id));
  const removed = b.places.filter(p => !curIds.has(p.id)).map(p => p.id);
  const modified = [];
  places.forEach(p => {
    const o = baseMap.get(p.id);
    if (!o) return;
    const set = {}, unset = [];
    Object.keys(p).forEach(k => { if (!sameJson(p[k], o[k])) set[k] = p[k]; });
    Object.keys(o).forEach(k => { if (!(k in p)) unset.push(k); });
    // `full` is a complete copy of the edited stop. If the baked-in sample is ever
    // changed (stop renamed/renumbered/removed), the stop is rebuilt from this copy
    // instead of the edit being silently dropped.
    if (Object.keys(set).length || unset.length) modified.push({ id: p.id, set, unset, full: p });
  });

  const delta = { base, places: { added, removed, modified }, myList };
  // id -> name of every baked-in stop at save time, so ids can be re-matched by name
  // if the sample file is later regenerated with different ids.
  delta.baseNames = Object.fromEntries(b.places.map(p => [p.id, p.name]));
  // Full copies of unedited sample stops that are on My list, so they survive the sample dropping them.
  const listed = new Set(myList.map(e => e.placeId));
  delta.pinned = places.filter(p => baseMap.has(p.id) && listed.has(p.id) && !modified.some(m => m.id === p.id));
  // Order is only saved if it differs from "sample order, then new stops at the end"
  const expected = [...b.places.filter(p => !removed.includes(p.id)).map(p => p.id), ...added.map(p => p.id)];
  const actual = places.map(p => p.id);
  if (!sameJson(expected, actual)) delta.order = actual;
  if (!sameJson(packages, b.packages)) delta.packages = packages;
  return delta;
}

/* ============ ID sanitising (import / shared-trip boundary) ============ */
// Stop, package and My-list ids get interpolated into inline onclick="...('${id}')"
// strings all over the UI. Anything that arrives from outside (an imported JSON
// file, or a shared trip written by someone else) is therefore reduced to
// [A-Za-z0-9_-] here, so a crafted id like  s1'); alert(1); //  can never break out
// of the attribute or the JS string. '#' is deliberately NOT allowed: it is
// LOC_SEP, the separator used for derived branch ids (`${placeId}#${i}`), and
// those are generated, never stored.
function sanitizeId(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
}

// Cleans item.id in place. Returns a Map of original id -> clean id so that
// references (place.packageId, myList[].placeId) can be re-pointed consistently.
// Empty results and collisions get a unique, safe replacement.
function cleanIds(items, prefix) {
  const used = new Set(), map = new Map();
  items.forEach((it, i) => {
    const raw = it.id;
    const base = sanitizeId(raw) || `${prefix}${i}`;
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    if (!map.has(raw)) map.set(raw, id);
    it.id = id;
  });
  return map;
}

function sanitizeTripIds(res) {
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  res.places = (res.places || []).filter(isObj);
  res.packages = (res.packages || []).filter(isObj);
  res.myList = (res.myList || []).filter(isObj);

  const placeMap = cleanIds(res.places, 'stop');
  const pkgMap = cleanIds(res.packages, 'pkg-');
  const remap = (map, v) => map.has(v) ? map.get(v) : sanitizeId(v);

  res.places.forEach(p => {
    if (p.packageId != null && p.packageId !== '') p.packageId = remap(pkgMap, p.packageId) || null;
  });
  res.myList.forEach(e => {
    e.placeId = remap(placeMap, e.placeId);
    e.id = sanitizeId(e.id) || 'ml-' + sanitizeId(e.placeId);
  });
  return res;
}

function applyDelta(delta) {
  const b = deltaBase(delta.base || 'sample');
  const pd = delta.places || {};
  const baseById = new Map(b.places.map(p => [p.id, p]));
  const idByName = new Map(b.places.map(p => [p.name, p.id]));
  const oldNames = delta.baseNames || {};
  const idRemap = new Map();   // saved id -> id in the current sample
  const rescued = [];          // stops whose sample original is gone: rebuilt from saved full copies

  // Resolve a saved sample id to today's sample id (same id, or same name under a new id).
  const resolve = id => {
    if (baseById.has(id)) return id;
    const nid = oldNames[id] ? idByName.get(oldNames[id]) : null;
    if (nid) { idRemap.set(id, nid); return nid; }
    return null;
  };

  const removed = new Set();
  (pd.removed || []).forEach(id => { const r = resolve(id); if (r) removed.add(r); });

  const mods = new Map();
  (pd.modified || []).forEach(m => {
    const r = resolve(m.id);
    if (r) mods.set(r, m);
    else if (m.full) rescued.push(m.full);          // sample stop vanished: keep the user's version
  });
  (delta.pinned || []).forEach(p => { if (!resolve(p.id)) rescued.push(p); });

  let list = b.places.filter(p => !removed.has(p.id)).map(p => {
    const m = mods.get(p.id);
    if (!m) return p;
    const q = { ...p, ...m.set };
    (m.unset || []).forEach(k => delete q[k]);
    return q;
  });

  // Stops the user added (or rescued) must never collide with a sample id.
  const used = new Set(list.map(p => p.id));
  [...(pd.added || []), ...rescued].forEach(p => {
    if (!p || typeof p !== 'object') return;
    if (used.has(p.id)) {
      // Same id AND same name as a baked-in stop: this is a stop that was added before
      // it was burned into the sample. Keep the saved copy (it carries the user's edits)
      // in the sample's slot instead of adding a duplicate.
      const at = list.findIndex(q => q.id === p.id);
      if (at >= 0 && list[at].name === p.name) { list[at] = p; return; }
      const old = p.id; let n = 2, nid = old + '-u';
      while (used.has(nid)) nid = old + '-u' + n++;
      p = { ...p, id: nid };
      idRemap.set(old, nid);
    }
    used.add(p.id);
    list.push(p);
  });

  if (Array.isArray(delta.order)) {
    const byId = new Map(list.map(p => [p.id, p]));
    const ordered = delta.order.map(id => byId.get(idRemap.get(id) || id)).filter(Boolean);
    const seen = new Set(ordered.map(p => p.id));
    list = ordered.concat(list.filter(p => !seen.has(p.id))); // stops added to the sample later still show up
  }

  const myList = (Array.isArray(delta.myList) ? delta.myList : [])
    .map(e => e && idRemap.has(e.placeId) ? { ...e, placeId: idRemap.get(e.placeId) } : e);

  return sanitizeTripIds({
    places: list,
    packages: Array.isArray(delta.packages) ? delta.packages : b.packages,
    myList
  });
}

// What gets written to storage for the current trip
function serializeTrip(trip) {
  const base = trip.id === 'trip-default' ? 'sample' : 'none';
  return JSON.stringify({ delta: computeDelta(places, packages, myList, base) });
}

// Reads either the new { delta } format or the old full format.
// Old full data is re-linked to the baked-in stops by name, so stops that match
// the sample are NOT treated as new (that is what made saves huge).
function applyParsedTrip(parsed) {
  if (parsed && parsed.delta) return applyDelta(parsed.delta);
  let res;
  if (Array.isArray(parsed)) res = { places: parsed, packages: [], myList: [] };
  else res = {
    places: Array.isArray(parsed.places) ? parsed.places : [],
    packages: Array.isArray(parsed.packages) ? parsed.packages : [],
    myList: readMyList(parsed)
  };
  res.places = res.places.filter(p => p && typeof p === 'object');
  res.myList = res.myList.filter(e => e && typeof e === 'object');
  const ids = new Set(SAMPLE_PLACES.map(p => p.id));
  const byName = new Map(SAMPLE_PLACES.map(p => [p.name, p.id]));
  const idMap = {};
  res.places.forEach(p => {
    if (ids.has(p.id)) return;
    const sid = byName.get(p.name);
    if (sid) { idMap[p.id] = sid; p.id = sid; }
  });
  res.myList = res.myList.map(e => ({ ...e, placeId: idMap[e.placeId] || e.placeId }));
  return sanitizeTripIds(res);
}

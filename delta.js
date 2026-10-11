/* ============ Delta: store only what differs from the baked-in sample ============ */
// base 'sample' = SAMPLE_PLACES/SAMPLE_PACKAGES (the default trip); 'none' = empty (other trips).
// Plain script: load AFTER sample-packages.js and BEFORE app.js.
const DELTA_FORMAT = 'delta-v1';
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
    if (Object.keys(set).length || unset.length) modified.push({ id: p.id, set, unset });
  });

  const delta = { base, places: { added, removed, modified }, myList };
  // Order is only saved if it differs from "sample order, then new stops at the end"
  const expected = [...b.places.filter(p => !removed.includes(p.id)).map(p => p.id), ...added.map(p => p.id)];
  const actual = places.map(p => p.id);
  if (!sameJson(expected, actual)) delta.order = actual;
  if (!sameJson(packages, b.packages)) delta.packages = packages;
  return delta;
}

function applyDelta(delta) {
  const b = deltaBase(delta.base || 'sample');
  const pd = delta.places || {};
  const removed = new Set(pd.removed || []);
  const mods = new Map((pd.modified || []).map(m => [m.id, m]));

  let list = b.places.filter(p => !removed.has(p.id)).map(p => {
    const m = mods.get(p.id);
    if (!m) return p;
    const q = { ...p, ...m.set };
    (m.unset || []).forEach(k => delete q[k]);
    return q;
  }).concat(pd.added || []);

  if (Array.isArray(delta.order)) {
    const byId = new Map(list.map(p => [p.id, p]));
    const ordered = delta.order.map(id => byId.get(id)).filter(Boolean);
    const seen = new Set(ordered.map(p => p.id));
    list = ordered.concat(list.filter(p => !seen.has(p.id))); // stops added to the sample later still show up
  }
  return {
    places: list,
    packages: Array.isArray(delta.packages) ? delta.packages : b.packages,
    myList: Array.isArray(delta.myList) ? delta.myList : []
  };
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
  const ids = new Set(SAMPLE_PLACES.map(p => p.id));
  const byName = new Map(SAMPLE_PLACES.map(p => [p.name, p.id]));
  const idMap = {};
  res.places.forEach(p => {
    if (ids.has(p.id)) return;
    const sid = byName.get(p.name);
    if (sid) { idMap[p.id] = sid; p.id = sid; }
  });
  res.myList = res.myList.map(e => ({ ...e, placeId: idMap[e.placeId] || e.placeId }));
  return res;
}

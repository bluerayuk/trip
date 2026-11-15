/* ============ Nearest-first display order (Explore + My attractions) ============ */
// View-only: never touches `places` / `myList` order. Plain script, load BEFORE app.js.
let proximitySort = false;

/* ---- Browse by time added: Trip order | Oldest added first | Newest added first ---- */
// "Oldest first" gives the original sequence (stop 1 = photo 1.jpg, stop 2 = 2.jpg ...). The age of a stop is,
// in order: addedAt, a timestamp id (stops added in the app), the number in its photo filename, a small
// numeric id, then its position in the trip. View-only: `places` / `myList` order is never touched.
let addedOrder = 'trip';
const ADDED_ORDER_OPTIONS = [['trip', 'Trip order'], ['oldest', 'Oldest added first'], ['newest', 'Newest added first']];

function initAddedOrder() {
  try { const v = localStorage.getItem('addedOrder'); if (ADDED_ORDER_OPTIONS.some(o => o[0] === v)) addedOrder = v; } catch (e) {}
  syncAddedOrderUi();
}
function syncAddedOrderUi() {
  const s = document.getElementById('addedOrderSelect');
  if (s) s.value = addedOrder;
}
function setAddedOrder(v) {
  addedOrder = ADDED_ORDER_OPTIONS.some(o => o[0] === v) ? v : 'trip';
  try { localStorage.setItem('addedOrder', addedOrder); } catch (e) {}
  syncAddedOrderUi();
  renderFilterMenu();
  renderPlaces();
}
function onAddedOrderChange() {
  const s = document.getElementById('addedOrderSelect');
  setAddedOrder(s ? s.value : 'trip');
}
// Manual reordering makes no sense while the view is sorted.
function orderLocked() { return proximitySort || addedOrder !== 'trip'; }

function addedMenuHtml() {
  return '<div class="trip-more-divider"></div>' + ADDED_ORDER_OPTIONS.map(([v, l]) => `
      <button type="button" class="trip-more-item trip-more-shared${addedOrder === v ? ' on' : ''}" role="menuitemradio" aria-checked="${addedOrder === v}" data-added-order="${v}">
        <span>${escapeHtml(l)}</span><span class="trip-more-check" aria-hidden="true">✓</span>
      </button>`).join('');
}

// Returns [group, key]. Stops whose cover photo is a numbered file in the image folder
// (images/6.jpg -> 6) come first, ordered by that number: the photo database defines the order.
// Stops without one follow, ordered by addedAt, then timestamp id, then position in the trip.
function addedKey(p, idx) {
  const file = String(p.image || '').split(/[?#]/)[0].split('/').pop();
  const m = !/^(https?|data|blob):/i.test(String(p.image || '')) && file.match(/^(\d+)\.[a-z0-9]+$/i);
  if (m) return [0, Number(m[1])];
  if (typeof p.addedAt === 'number') return [1, p.addedAt];
  const idn = /^\d+$/.test(String(p.id)) ? Number(p.id) : NaN;
  if (!Number.isNaN(idn)) return [1, idn];
  return [1, idx];
}

function sortByAdded(list) {
  if (addedOrder === 'trip') return list;
  const dir = addedOrder === 'newest' ? -1 : 1;
  return list
    .map((p, i) => {
      const base = places.find(x => x.id === baseIdOf(p.id)) || p;
      const bi = places.indexOf(base);
      return { p, i, k: addedKey(base, bi < 0 ? i : bi) };
    })
    // group 0 (numbered photos) always stays ahead of group 1; direction only applies within a group
    .sort((a, b) => (a.k[0] - b.k[0]) || dir * (a.k[1] - b.k[1]) || a.i - b.i)
    .map(x => x.p);
}

function initProximitySort() {
  try { proximitySort = localStorage.getItem('proximitySort') === '1'; } catch (e) {}
  const cb = document.getElementById('proximitySortToggle');
  if (cb) cb.checked = proximitySort;
}
function setProximitySort(on) {
  proximitySort = !!on;
  try { localStorage.setItem('proximitySort', proximitySort ? '1' : '0'); } catch (e) {}
  const cb = document.getElementById('proximitySortToggle');
  if (cb) cb.checked = proximitySort;
  renderFilterMenu();
  renderPlaces();
}
function onProximitySortChange() {
  const cb = document.getElementById('proximitySortToggle');
  setProximitySort(!!(cb && cb.checked));
}

function proximityKm(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Nearest-neighbour chain from the first located card; unlocated cards go last.
function sortByProximity(list) {
  list = sortByAdded(list);
  if (!proximitySort) return list;
  const loc = p => typeof p.lat === 'number' && typeof p.lng === 'number';
  const located = list.filter(loc), rest = list.filter(p => !loc(p));
  if (located.length < 2) return list;
  const out = [located[0]], remaining = located.slice(1);
  while (remaining.length) {
    const cur = out[out.length - 1];
    let bi = 0, bk = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const km = proximityKm(cur, remaining[i]);
      if (km < bk) { bk = km; bi = i; }
    }
    out.push(remaining.splice(bi, 1)[0]);
  }
  return out.concat(rest);
}

// Split view: after a late geocode gives a stop coordinates, move its row into place.
// Skipped while a route is running (the route helper owns the list order then).
function resortSplitListByProximity() {
  if (!proximitySort) return;
  if (typeof tourIds !== 'undefined' && tourIds.length) return;
  const list = document.querySelector('.split-list');
  if (!list) return;
  const rows = [...list.querySelectorAll('.split-row')];
  const byId = new Map(rows.map(r => [r.dataset.id, r]));
  const entries = rows.map(r => findMapEntry(r.dataset.id)).filter(Boolean);
  sortByProximity(entries).forEach(e => { const r = byId.get(e.id); if (r) list.appendChild(r); });
}

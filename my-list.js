/* ============ My attractions (separate collection) ============ */
// `myList` (state lives in app.js, saved with places/packages per trip) is its own
// ordered array of entries: { id, placeId, day, note }. `placeId` points at a stop in
// the database (`places`); day/note/order belong to the list. Bookmarked stops stay
// visible in Explore (filled bookmark) unless "Hide shortlisted" is on; `places` itself
// is never reordered by list actions, so a stop always keeps its original slot.

// Two screens: 'explore' (the database) and 'mylist' (only what was added). Body classes
// (tab-explore / tab-mylist) drive what is visible; see styles.css.
let activeTab = 'explore';
function setTab(tab) {
  activeTab = tab === 'mylist' ? 'mylist' : 'explore';
  document.body.classList.toggle('tab-mylist', activeTab === 'mylist');
  document.body.classList.toggle('tab-explore', activeTab === 'explore');
  [['tabExplore', 'explore'], ['tabMyList', 'mylist']].forEach(([id, t]) => {
    const b = document.getElementById(id);
    if (b) { b.classList.toggle('active', t === activeTab); b.setAttribute('aria-selected', String(t === activeTab)); }
  });
  renderPlaces();
  window.scrollTo({ top: 0 });
}
function updateTabCount() {
  const el = document.getElementById('tabMyListCount');
  if (el) el.textContent = myList.length;
  const all = document.getElementById('tabExploreCount');   // every stop in the database for this trip
  if (all) all.textContent = places.length;
}

function readMyList(parsed) {
  if (Array.isArray(parsed.myList)) return parsed.myList;
  // Migration: older saves/exports only had a bare array of ids.
  if (Array.isArray(parsed.myListIds)) {
    return parsed.myListIds.map(id => ({ id: 'ml-' + id, placeId: id, day: '', note: '' }));
  }
  return [];
}

function isInMyList(placeId) { return myList.some(e => e.placeId === placeId); }

// Drops entries whose stop no longer exists (deleted, imported over, reset...).
function pruneMyList() {
  const ids = new Set(places.map(p => p.id));
  if (myList.some(e => !ids.has(e.placeId))) myList = myList.filter(e => ids.has(e.placeId));
}

// Database stops merged with the list's own fields, in list order. The merged copy keeps
// the stop's id, so cards, map, route helper and totals work unchanged.
function getMyListPlaces() {
  return myList.map(e => {
    const p = places.find(x => x.id === e.placeId);
    return p ? { ...p, day: e.day || p.day || '', note: e.note || '' } : null;
  }).filter(Boolean);
}

// The list as shown on the My attractions tab: category filter + search apply here too.
function getMyListVisiblePlaces() {
  let list = getMyListPlaces();
  if (currentFilter !== 'all') list = list.filter(p => p.category === currentFilter);
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (q) list = list.filter(p => [p.name, p.summary, p.desc, p.address].some(v => (v || '').toLowerCase().includes(q)));
  return list;
}

/* ---- "Hide shortlisted" (Explore only; off by default, remembered per browser) ---- */
let hideShortlisted = false;
function initHideShortlisted() {
  try { hideShortlisted = localStorage.getItem('hideShortlisted') === '1'; } catch (e) {}
  const cb = document.getElementById('hideShortlistedToggle');
  if (cb) cb.checked = hideShortlisted;
}
function setHideShortlisted(on) {
  hideShortlisted = !!on;
  try { localStorage.setItem('hideShortlisted', hideShortlisted ? '1' : '0'); } catch (e) {}
  const cb = document.getElementById('hideShortlistedToggle');
  if (cb) cb.checked = hideShortlisted;
  renderFilterMenu();
  renderPlaces();
}
function onHideShortlistedChange() {
  const cb = document.getElementById('hideShortlistedToggle');
  setHideShortlisted(!!(cb && cb.checked));
}

async function toggleMyList(id) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  const inList = isInMyList(id);
  // A card only leaves the screen when removed from My attractions, or when
  // bookmarked while "Hide shortlisted" is on. Otherwise it stays put and just
  // flips its bookmark, so nothing seems to disappear.
  const leaving = activeTab === 'mylist' || (!inList && hideShortlisted);
  if (leaving) await animateCardsOut([id]);
  if (inList) myList = myList.filter(e => e.placeId !== id);
  else myList.push({ id: 'ml-' + Date.now() + Math.random().toString(36).slice(2), placeId: id, day: '', note: '' });
  if (!leaving) lastFocusId = id; // keep keyboard focus on the card after the re-render
  renderPlaces();
  if (leaving) animateCardsIn([id]);
  await persistPlaces();
  showToast(inList ? 'Removed from My attractions'
    : hideShortlisted ? 'Added to My attractions (hidden in Explore)' : 'Added to My attractions');
  announce(`${place.name} ${inList ? 'removed from' : 'added to'} My attractions`);
}

function updateMyListBudgetTotal() {
  const el = document.getElementById('myListBudgetTotal');
  if (!el) return;
  el.innerHTML = budgetTotalHtml(computeTotal(getMyListPlaces()));
}

function renderMyList() {
  const grid = document.getElementById('myListGrid');
  const empty = document.getElementById('myListEmpty');
  const section = document.getElementById('myListSection');
  if (!grid) return;
  updateMyListBudgetTotal();
  updateTabCount();
  const myPlaces = getMyListPlaces();
  const shown = sortByProximity(expandMapEntries(getMyListVisiblePlaces())); // one card per location
  grid.innerHTML = '';
  if (empty) empty.innerHTML = myPlaces.length === 0
    ? 'Nothing added yet. Tap the bookmark on any attraction in Explore to add it here.<br><button type="button" class="icon-text-btn browse-btn" onclick="setTab(\'explore\')">Browse attractions</button>'
    : 'No stops in your list match the current filter or search.';
  if (shown.length === 0) {
    grid.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (section) section.classList.toggle('is-empty', myPlaces.length === 0);
    return;
  }
  if (empty) empty.style.display = 'none';
  if (section) section.classList.remove('is-empty');

  if (!isMyListGrouped()) {
    grid.style.display = '';
    shown.forEach((place, i) => grid.appendChild(buildCardEl(place, i, shown, { draggable: false, context: 'mylist' })));
    return;
  }
  grid.style.display = 'block'; // groups stack; each has its own grid
  const groups = [], map = {};
  shown.forEach(p => { const k = myListDayKey(p); if (!map[k]) { map[k] = []; groups.push(k); } map[k].push(p); });
  groups.forEach(k => {
    const wrap = document.createElement('div');
    wrap.className = 'day-group';
    wrap.innerHTML = `<h3 class="day-group-title">${escapeHtml(k)} <span class="count">${map[k].length} stop${map[k].length > 1 ? 's' : ''}</span></h3>`;
    const g = document.createElement('div');
    g.className = 'grid-container';
    map[k].forEach(p => g.appendChild(buildCardEl(p, shown.indexOf(p), shown, { draggable: false, context: 'mylist' })));
    wrap.appendChild(g);
    grid.appendChild(wrap);
  });
}

/* ---- Day / note / order editing for the shortlist ---- */
const myListDayKey = p => ((p && p.day) || '').trim() || UNSCHEDULED_KEY;
const isMyListGrouped = () => { const t = document.getElementById('groupByDayToggle'); return !!(t && t.checked); };

// Notes need no re-render; a day change can move the card to another group.
async function updateMyListField(placeId, field, value) {
  const e = myList.find(x => x.placeId === placeId);
  if (!e) return;
  value = String(value || '').trim();
  if ((e[field] || '') === value) return;
  e[field] = value;
  if (field === 'day') renderPlaces();
  await persistPlaces();
}

// Reorders the shortlist itself (never `places`). Swaps with the neighbour in the
// visible list, restricted to the same day group when grouping is on.
async function moveMyListEntry(placeId, dir) {
  if (orderLocked()) { showToast('Set the order to "Trip order" and turn off "Nearest first" to reorder'); return; }
  let vis = getMyListVisiblePlaces();
  if (isMyListGrouped()) {
    const k = myListDayKey(vis.find(p => p.id === placeId));
    vis = vis.filter(p => myListDayKey(p) === k);
  }
  const i = vis.findIndex(p => p.id === placeId), j = i + dir;
  if (i < 0 || j < 0 || j >= vis.length) return;
  const a = myList.findIndex(e => e.placeId === placeId);
  const b = myList.findIndex(e => e.placeId === vis[j].id);
  undoSnapshot = JSON.stringify(places);
  undoPackagesSnapshot = null;
  undoMyListSnapshot = JSON.stringify(myList);
  [myList[a], myList[b]] = [myList[b], myList[a]];
  renderPlaces();
  await persistPlaces();
  announce(`${vis[i].name} moved ${dir < 0 ? 'up' : 'down'} in My attractions`);
}

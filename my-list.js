/* ============ My attractions (separate collection) ============ */
// `myList` (state lives in app.js, saved with places/packages per trip) is its own
// ordered array of entries: { id, placeId, day, note }. `placeId` points at a stop in
// the database (`places`); day/note/order belong to the list. Bookmarked stops are
// hidden from the main grid (getVisiblePlaces) and return to their original slot when
// removed from the list, because `places` itself is never reordered by list actions.

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

async function toggleMyList(id) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  const inList = isInMyList(id);
  await animateCardsOut([id]);
  if (inList) myList = myList.filter(e => e.placeId !== id);
  else myList.push({ id: 'ml-' + Date.now() + Math.random().toString(36).slice(2), placeId: id, day: '', note: '' });
  renderPlaces();
  animateCardsIn([id]);
  await persistPlaces();
  showToast(inList ? 'Removed - back in Explore' : 'Added to My attractions');
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
  const shown = getMyListVisiblePlaces();
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
  grid.style.display = '';
  if (empty) empty.style.display = 'none';
  if (section) section.classList.remove('is-empty');
  shown.forEach((place, i) => {
    grid.appendChild(buildCardEl(place, i, shown, { draggable: false, context: 'mylist' }));
  });
}

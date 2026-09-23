  /* ============ Storage shim ============ */
  // window.storage is provided automatically inside Claude.ai artifacts.
  // Running this file standalone (e.g. opened directly, or hosted elsewhere)?
  // Fall back to localStorage so the app still works outside that sandbox.
  if (!window.storage) {
    window.storage = {
      async get(key, shared) {
        const raw = localStorage.getItem((shared ? 'shared:' : 'private:') + key);
        if (raw === null) throw new Error('not found');
        return { key, value: raw, shared: !!shared };
      },
      async set(key, value, shared) {
        localStorage.setItem((shared ? 'shared:' : 'private:') + key, value);
        return { key, value, shared: !!shared };
      },
      async delete(key, shared) {
        localStorage.removeItem((shared ? 'shared:' : 'private:') + key);
        return { key, deleted: true, shared: !!shared };
      },
      async list(prefix, shared) {
        const p = (shared ? 'shared:' : 'private:') + (prefix || '');
        const keys = Object.keys(localStorage).filter(k => k.startsWith(p)).map(k => k.slice((shared ? 'shared:' : 'private:').length));
        return { keys, prefix, shared: !!shared };
      }
    };
  }

  /* ============ State ============ */
  let places = [];
  let packages = [];           // [{id, name, cost}] — shared prices covering multiple stops
  let myList = [];             // separate ordered list: [{id, placeId, day, note}] (see my-list.js), per trip
  let trips = [];              // [{id, name, shared}]
  let currentTripId = null;

  /* ============ Mobile detection ============ */
  // Feature-based, not UA-sniffed: a coarse primary pointer (finger, not
  // mouse/trackpad) is what actually predicts "drag-and-drop won't work
  // nicely here", regardless of screen size or device name. We combine it
  // with a width check so a touch-enabled desktop monitor doesn't get the
  // mobile UI. Re-evaluated live via matchMedia listeners below, so e.g.
  // rotating a tablet or resizing a window updates the UI without a reload.
  const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
  const narrowScreenQuery = window.matchMedia('(max-width: 760px)');
  function isMobileUI() {
    return coarsePointerQuery.matches && narrowScreenQuery.matches;
  }
  let wasMobileUI = isMobileUI();
  function handleMobileUIChange() {
    const nowMobileUI = isMobileUI();
    if (nowMobileUI === wasMobileUI) return; // only re-render on an actual flip
    wasMobileUI = nowMobileUI;
    if (!isLoading) renderPlaces();
  }
  coarsePointerQuery.addEventListener('change', handleMobileUIChange);
  narrowScreenQuery.addEventListener('change', handleMobileUIChange);

  /* ============ Phone top bar: [ trip picker ] [ price ] [ ⋮ ] ============ */
  // On phones (same 640px breakpoint as the CSS) the trip picker and the ⋮
  // menu are moved into the fixed #mobileTopbar around the price badge; on
  // wider screens they're put back exactly where they were in the trip bar.
  // Moving the real elements (rather than duplicating them) keeps every
  // existing listener and id working.
  const phoneTopbarQuery = window.matchMedia('(max-width: 640px)');
  const topbarMovables = ['.trip-select-wrap', '.trip-more-wrap'].map(sel => {
    const el = document.querySelector(sel);
    return el ? { el, parent: el.parentNode, next: el.nextSibling } : null;
  }).filter(Boolean);
  function syncTopbarPlacement() {
    const topbar = document.getElementById('mobileTopbar');
    const badge = document.getElementById('stickyTotalBadge');
    if (!topbar || !badge) return;
    if (phoneTopbarQuery.matches) {
      topbarMovables.forEach(m => {
        if (m.el.matches('.trip-select-wrap')) topbar.insertBefore(m.el, badge); // before the price
        else topbar.appendChild(m.el);                                          // after the price
      });
    } else {
      topbarMovables.forEach(m => m.parent.insertBefore(m.el, m.next));
    }
  }
  phoneTopbarQuery.addEventListener('change', syncTopbarPlacement);
  syncTopbarPlacement();

  let currentFilter = 'all';
  let currentView = 'grid';
  let editingId = null;
  let confirmingDeleteId = null;
  let isLoading = true;
  let lastFocusId = null;
  let undoSnapshot = null;
  let undoPackagesSnapshot = null; // only set when an action also changes packages[]
  let lastKnownTripValue = null;   // raw JSON string last seen from storage for the current trip, used to detect remote changes
  let pollIntervalId = null;       // live-sync poll timer, only runs while viewing a shared trip

  const viewContainer = document.getElementById('viewContainer');
  const TRIPS_INDEX_KEY = 'trips-index';
  const UNSCHEDULED_KEY = 'Unscheduled'; // group key used for stops with no "day" set

  // SAMPLE_PLACES lives in sample-places.js and SAMPLE_PACKAGES in sample-packages.js (both loaded before this file).

  /* ============ Storage: trips index ============ */
  async function loadTripsIndex() {
    try {
      const res = await window.storage.get(TRIPS_INDEX_KEY);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        if (Array.isArray(parsed) && parsed.length > 0) { trips = parsed; return; }
      }
    } catch (e) { /* none yet */ }
    trips = [{ id: 'trip-default', name: 'NY & Long Island', shared: false }];
    await persistTripsIndex();
  }

  async function persistTripsIndex() {
    try { await window.storage.set(TRIPS_INDEX_KEY, JSON.stringify(trips)); } catch (e) { /* ignore */ }
  }

  function currentTrip() { return trips.find(t => t.id === currentTripId); }
  function tripPlacesKey(tripId) { return `trip-places:${tripId}`; }

  /* ============ Storage: places for current trip ============ */
  async function loadCurrentTripPlaces() {
    isLoading = true;
    renderPlaces();
    const trip = currentTrip();
    try {
      const res = await window.storage.get(tripPlacesKey(trip.id), !!trip.shared);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        if (Array.isArray(parsed)) { places = parsed; packages = []; myList = []; }
        else {
          places = Array.isArray(parsed.places) ? parsed.places : [];
          packages = Array.isArray(parsed.packages) ? parsed.packages : [];
          myList = readMyList(parsed);
        }
      } else {
        places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
        packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
        myList = [];
        await persistPlaces();
      }
    } catch (e) {
      places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
      packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
      myList = [];
      await persistPlaces();
    }
    isLoading = false;
    lastKnownTripValue = JSON.stringify({ places, packages, myList });
    populatePackageSelect();
    renderPlaces();
    syncPollingState();
  }

  async function persistPlaces() {
    const trip = currentTrip();
    if (!trip) return;
    const indicator = document.getElementById('saveIndicator');
    const text = document.getElementById('saveText');
    indicator.classList.add('saving');
    text.textContent = 'Saving...';
    try {
      const raw = JSON.stringify({ places, packages, myList });
      await window.storage.set(tripPlacesKey(trip.id), raw, !!trip.shared);
      lastKnownTripValue = raw; // this is now the latest known state; skip re-rendering our own write on the next poll
      text.textContent = 'Saved';
    } catch (e) {
      text.textContent = 'Save failed';
      // The Saved/Save-failed indicator lives in the trip card, which is hidden on
      // phones, so also surface a failure as a toast so it can't go unnoticed.
      showToast('Save failed - changes may not be stored');
    }
    setTimeout(() => indicator.classList.remove('saving'), 600);
    updateBudgetTotal();
  }

  /* ============ Live sync for shared trips ============ */
  // Shared trips are stored the same way as private ones, but with no push
  // mechanism nothing tells a viewer that someone else just changed the
  // data. This polls the shared storage key at a modest interval so a
  // second person's edits (including My attractions) show up without a
  // manual reload. Private trips never poll - they're only ever loaded by
  // the one person, so there's nothing else to sync against.
  function syncPollingState() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    const trip = currentTrip();
    if (trip && trip.shared) {
      pollIntervalId = setInterval(pollForRemoteChanges, 6000);
    }
  }

  async function pollForRemoteChanges() {
    const trip = currentTrip();
    if (!trip || !trip.shared) return;
    // Don't yank the rug out from under an in-progress drag, edit, or open
    // detail view - just wait for the next tick once they're done.
    if (draggedId || isAddPanelOpen()) return;
    const overlay = document.getElementById('detailModalOverlay');
    if (overlay && overlay.classList.contains('open')) return;
    try {
      const res = await window.storage.get(tripPlacesKey(trip.id), true);
      if (!res || !res.value || res.value === lastKnownTripValue) return;
      lastKnownTripValue = res.value;
      const parsed = JSON.parse(res.value);
      if (Array.isArray(parsed)) {
        places = parsed; packages = []; myList = [];
      } else {
        places = Array.isArray(parsed.places) ? parsed.places : [];
        packages = Array.isArray(parsed.packages) ? parsed.packages : [];
        myList = readMyList(parsed);
      }
      populatePackageSelect();
      renderPlaces();
      announce('Trip updated by another viewer');
    } catch (e) { /* transient read error - just try again on the next tick */ }
  }

  /* ============ Trip management ============ */
  function renderTripSelect() {
    const select = document.getElementById('tripSelect');
    select.innerHTML = trips.map(t => `<option value="${t.id}" ${t.id === currentTripId ? 'selected' : ''}>${escapeHtml(t.name)}${t.shared ? ' (shared)' : ''}</option>`).join('');
    document.getElementById('tripHeading').textContent = currentTrip() ? currentTrip().name : 'Trip itinerary';
    document.getElementById('sharedToggle').checked = !!currentTrip()?.shared;
    document.getElementById('sharedBadge').classList.toggle('show', !!currentTrip()?.shared);
    // Keep the mobile ⋮ menu's "Shared trip" item in sync with the trip's state.
    const sharedMenuItem = document.getElementById('sharedMenuItem');
    if (sharedMenuItem) {
      const isShared = !!currentTrip()?.shared;
      sharedMenuItem.setAttribute('aria-checked', String(isShared));
      sharedMenuItem.classList.toggle('on', isShared);
    }
  }

  document.getElementById('tripSelect').addEventListener('change', async (e) => {
    currentTripId = e.target.value;
    renderTripSelect();
    await loadCurrentTripPlaces();
  });

  async function createTrip() {
    const name = window.prompt('Name this trip:', 'New trip');
    if (!name || !name.trim()) return;
    const id = 'trip-' + Date.now();
    trips.push({ id, name: name.trim(), shared: false });
    await persistTripsIndex();
    currentTripId = id;
    places = [];
    packages = [];
    myList = [];
    await persistPlaces();
    renderTripSelect();
    renderPlaces();
    syncPollingState();
    showToast('Trip created');
  }

  async function renameTrip() {
    const trip = currentTrip();
    if (!trip) return;
    const name = window.prompt('Rename trip:', trip.name);
    if (!name || !name.trim()) return;
    trip.name = name.trim();
    await persistTripsIndex();
    renderTripSelect();
  }

  async function deleteTrip() {
    if (trips.length <= 1) { showToast("Can't delete your only trip"); return; }
    const trip = currentTrip();
    if (!window.confirm(`Delete "${trip.name}" and all its stops? This can't be undone.`)) return;
    try { await window.storage.delete(tripPlacesKey(trip.id), !!trip.shared); } catch (e) { /* ignore */ }
    trips = trips.filter(t => t.id !== trip.id);
    await persistTripsIndex();
    currentTripId = trips[0].id;
    renderTripSelect();
    await loadCurrentTripPlaces();
    showToast('Trip deleted');
  }

  async function toggleShared() {
    const trip = currentTrip();
    const checkbox = document.getElementById('sharedToggle');
    if (checkbox.checked) {
      const ok = window.confirm('Shared trips are visible to everyone using this app, not just you. Continue?');
      if (!ok) { checkbox.checked = false; return; }
      trip.shared = true;
    } else {
      trip.shared = false;
    }
    await persistTripsIndex();
    await persistPlaces();
    renderTripSelect();
    syncPollingState();
    showToast(trip.shared ? 'Trip is now shared' : 'Trip is now private');
  }

  // Mobile ⋮ menu entry for the Shared trip switch: flips the (hidden on
  // phones) checkbox and reuses toggleShared() so the confirm prompt, saving
  // and polling logic all stay in one place.
  function toggleSharedFromMenu() {
    const checkbox = document.getElementById('sharedToggle');
    checkbox.checked = !checkbox.checked;
    toggleTripMoreMenu(false);
    toggleShared();
  }

  /* Mobile "⋮" overflow menu for the trip-admin actions (Rename, Delete,
     Export, Import, Reset, Clear). Pass an explicit `open` to force a
     state (e.g. always-close after an action); omit it to just toggle. */
  function toggleTripMoreMenu(open) {
    const menu = document.getElementById('tripMoreMenu');
    const btn = document.getElementById('tripMoreBtn');
    if (!menu || !btn) return;
    const shouldOpen = open !== undefined ? open : !menu.classList.contains('open');
    menu.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
  }
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.trip-more-wrap');
    if (wrap && !wrap.contains(e.target)) toggleTripMoreMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleTripMoreMenu(false);
  });

  /* Mobile "⋯" overflow menu for Copy list/Print in the toolbar — same
     pattern as the trip bar's ⋮ menu above. */
  function toggleToolbarMoreMenu(open) {
    const menu = document.getElementById('toolbarMoreMenu');
    const btn = document.getElementById('toolbarMoreBtn');
    if (!menu || !btn) return;
    const shouldOpen = open !== undefined ? open : !menu.classList.contains('open');
    menu.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
  }
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('toolbarMoreWrap');
    if (wrap && !wrap.contains(e.target)) toggleToolbarMoreMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleToolbarMoreMenu(false);
  });

  /* Phone search: the magnifier button in the fixed top bar (after the price)
     shows/hides the search field, which slides in under the top bar. Closing
     it clears the query so a hidden filter can't silently keep stops out of the
     list. On wider screens the field is always visible and this is unused. */
  function toggleSearch(open) {
    const btn = document.getElementById('searchToggleBtn');
    const input = document.getElementById('searchInput');
    if (!btn || !input) return;
    const shouldOpen = open !== undefined ? open : !document.body.classList.contains('search-open');
    document.body.classList.toggle('search-open', shouldOpen);
    btn.classList.toggle('active', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      input.focus();
    } else if (input.value) {
      input.value = '';
      renderPlaces();
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('search-open')
        && document.activeElement === document.getElementById('searchInput')) toggleSearch(false);
  });

  /* Phone category filter: the funnel button in the top bar opens a list of
     "All" + every category (built from CATEGORY_LABELS). Picking one reuses the
     existing pill buttons' click handler, so filtering, the pills and this
     menu can never disagree. The funnel is highlighted while a filter is on. */
  function renderFilterMenu() {
    const menu = document.getElementById('filterMenu');
    const btn = document.getElementById('filterToggleBtn');
    if (!menu) return;
    const items = [['all', 'All'], ...Object.entries(CATEGORY_LABELS)];
    const groupToggle = document.getElementById('groupByDayToggle');
    const groupOn = !!(groupToggle && groupToggle.checked);
    menu.innerHTML = items.map(([id, label]) => `
      <button type="button" class="trip-more-item trip-more-shared${currentFilter === id ? ' on' : ''}" role="menuitemradio" aria-checked="${currentFilter === id}" data-filter="${escapeHtml(id)}">
        <span>${escapeHtml(label)}</span><span class="trip-more-check" aria-hidden="true">✓</span>
      </button>`).join('') + `
      <div class="trip-more-divider"></div>
      <button type="button" class="trip-more-item trip-more-shared${groupOn ? ' on' : ''}" role="menuitemcheckbox" aria-checked="${groupOn}" data-group-toggle="1">
        <span>Group by day</span><span class="trip-more-check" aria-hidden="true">✓</span>
      </button>`;
    if (btn) btn.classList.toggle('active', currentFilter !== 'all');
  }
  function toggleFilterMenu(open) {
    const menu = document.getElementById('filterMenu');
    const btn = document.getElementById('filterToggleBtn');
    if (!menu || !btn) return;
    const shouldOpen = open !== undefined ? open : !menu.classList.contains('open');
    menu.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
  }
  document.getElementById('filterMenu').addEventListener('click', (e) => {
    // "Group by day" lives in this menu on phones; it flips the same (hidden) checkbox the toolbar uses.
    if (e.target.closest('[data-group-toggle]')) {
      const cb = document.getElementById('groupByDayToggle');
      cb.checked = !cb.checked;
      renderFilterMenu();
      renderPlaces();
      toggleFilterMenu(false);
      return;
    }
    const item = e.target.closest('[data-filter]');
    if (!item) return;
    const pill = document.querySelector(`#filterGroup .pill-btn[data-filter="${item.dataset.filter}"]`);
    if (pill) pill.click();
    toggleFilterMenu(false);
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('filterMenuWrap');
    if (wrap && !wrap.contains(e.target)) toggleFilterMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleFilterMenu(false);
  });

  /* Phone view switcher: one icon button in the top bar shows the current view
     (grid / map / split) and opens a small menu to change it. Picking an item
     calls setView(), the same function the desktop Grid/Map/Split pills use. */
  const VIEW_ICONS = {
    grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="2"/></svg>',
    map: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.4" stroke="currentColor" stroke-width="2"/></svg>',
    split: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 4.5v15" stroke="currentColor" stroke-width="2"/></svg>'
  };
  const VIEW_LABELS = { grid: 'Grid', map: 'Map', split: 'Split (list + map)' };
  function renderViewMenu() {
    const btn = document.getElementById('viewToggleBtn');
    const menu = document.getElementById('viewMenu');
    if (btn) {
      btn.innerHTML = VIEW_ICONS[currentView] || VIEW_ICONS.grid;
      btn.setAttribute('aria-label', `Change view (now: ${VIEW_LABELS[currentView] || 'Grid'})`);
    }
    if (menu) menu.innerHTML = Object.keys(VIEW_ICONS).map(v => `
      <button type="button" class="trip-more-item trip-more-shared view-item${currentView === v ? ' on' : ''}" role="menuitemradio" aria-checked="${currentView === v}" data-view-pick="${v}">
        <span class="view-item-label">${VIEW_ICONS[v]}${escapeHtml(VIEW_LABELS[v])}</span><span class="trip-more-check" aria-hidden="true">✓</span>
      </button>`).join('');
  }
  function toggleViewMenu(open) {
    const menu = document.getElementById('viewMenu');
    const btn = document.getElementById('viewToggleBtn');
    if (!menu || !btn) return;
    const shouldOpen = open !== undefined ? open : !menu.classList.contains('open');
    menu.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
  }
  document.getElementById('viewMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-view-pick]');
    if (!item) return;
    toggleViewMenu(false);
    setView(item.dataset.viewPick);
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('viewMenuWrap');
    if (wrap && !wrap.contains(e.target)) toggleViewMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleViewMenu(false);
  });

  /* Mobile "Sharing & packages" disclosure in the trip bar — collapsed by
     default so Shared trip + Packages don't cost screen space until asked
     for. On desktop the panel this controls is always shown (the toggle
     button itself is hidden via CSS), so this only matters on phones. */
  function toggleTripDetails(open) {
    const panel = document.getElementById('tripDetailsPanel');
    const btn = document.getElementById('tripDetailsToggle');
    if (!panel || !btn) return;
    const shouldOpen = open !== undefined ? open : !panel.classList.contains('open');
    panel.classList.toggle('open', shouldOpen);
    btn.setAttribute('aria-expanded', String(shouldOpen));
  }

  async function clearAllStops() {
    if (places.length === 0) return;
    if (!window.confirm('Remove all stops from this trip?')) return;
    undoSnapshot = JSON.stringify(places);
    places = [];
    renderPlaces();
    await persistPlaces();
    showUndoToast('All stops cleared');
  }

  async function resetToSample() {
    if (!window.confirm('Replace this trip\'s stops with the sample itinerary?')) return;
    undoSnapshot = JSON.stringify(places);
    undoPackagesSnapshot = JSON.stringify(packages);
    places = JSON.parse(JSON.stringify(SAMPLE_PLACES)).map(p => ({ ...p, id: Date.now().toString() + Math.random().toString(36).slice(2) }));
    packages = JSON.parse(JSON.stringify(SAMPLE_PACKAGES));
    renderPlaces();
    await persistPlaces();
    showUndoToast('Reset to sample trip');
  }

  /* Export / import / copy-to-clipboard live in export-import.js. */

  /* ============ Description rendering (tip cards, line breaks) ============ */
  // Small monochrome icons (currentColor) used to badge each tip card and
  // the Insider Hack / Good to know callouts, keyed by a short name so the
  // category-detection logic below can just say "this tip gets the clock".
  const TIP_ICONS = {
    ticket: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 8v8" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    camera: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1-1.6A1.5 1.5 0 0 1 10 4.6h4a1.5 1.5 0 0 1 1.3.8l1 1.6h2.2A1.5 1.5 0 0 1 20 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17V8.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.2" stroke="currentColor" stroke-width="1.6"/></svg>',
    shield: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stairs: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 20v-4h4v-4h4V8h4V4h4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    bulb: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.45 1 .9 1.1 1.6h4.8c.1-.7.5-1.15 1.1-1.6A6 6 0 0 0 12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    coin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v10M9.5 9.3c0-1.2 1.1-2 2.5-2s2.5.8 2.5 1.8c0 2.4-5 1.4-5 3.8 0 1 1.1 1.9 2.5 1.9s2.5-.8 2.5-1.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>'
  };

  // Keyword-based categorization used to pick each tip card's icon/color.
  // Not a real taxonomy — a tip with no keyword match falls back to the
  // neutral "Good to know" bucket rather than being mis-sorted into an
  // unrelated one.
  const TIP_ICON_CATEGORIES = [
    { name: 'Tickets & Booking', iconKey: 'ticket', cssKey: 'ticket', keywords: ['ticket', 'book', 'reservation', 'reserve', 'admission', 'advance', 'pass', 'entry'] },
    { name: 'Logistics & Timing', iconKey: 'clock', cssKey: 'timing', keywords: ['budget', 'hour', 'minute', 'early', 'arrive', 'schedule', 'queue', 'line', 'crowd', 'weekday', 'weekend', 'morning', 'evening', 'time slot'] },
    { name: 'Photography', iconKey: 'camera', cssKey: 'photo', keywords: ['photo', 'camera', 'view', 'angle', 'picture', 'glass', 'skyline', 'composition', 'shot'] },
    { name: 'Rules & Safety', iconKey: 'shield', cssKey: 'safety', keywords: ['security', 'bag', 'prohibit', 'screening', ' id', 'wristband', 'locker', 'allowed', 'strict'] },
    { name: 'Getting Around', iconKey: 'stairs', cssKey: 'stairs', keywords: ['stairs', 'steps', 'climb', 'elevator', 'narrow', 'flight'] }
  ];
  const DEFAULT_TIP_CATEGORY = { name: 'Good to know', iconKey: 'bulb', cssKey: 'default' };

  function detectTipCategory(text) {
    const lower = text.toLowerCase();
    let best = null, bestScore = 0;
    TIP_ICON_CATEGORIES.forEach(cat => {
      const score = cat.keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = cat; }
    });
    return best || DEFAULT_TIP_CATEGORY;
  }

  const BULLET_RE = /^[-*•]\s+/;
  const NUM_RE = /^\d+[.)]\s+/;
  const stripMarker = l => l.replace(BULLET_RE, '').replace(NUM_RE, '');

  // Breaks a raw tips-and-tricks string into "chunks" — either a
  // heading+body paragraph (a short first line followed by body lines) or
  // a single sentence (a lone bullet, or a stray line with no blank-line
  // neighbors). Each chunk still needs a title before it can become a card.
  function splitIntoTipChunks(desc) {
    const blocks = [];
    let current = [];
    for (const raw of desc.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') { if (current.length) { blocks.push(current); current = []; } }
      else current.push(line);
    }
    if (current.length) blocks.push(current);

    const chunks = [];
    blocks.forEach(blockLines => {
      const allBullets = blockLines.every(l => BULLET_RE.test(l) || NUM_RE.test(l));
      if (allBullets) {
        blockLines.forEach(l => chunks.push(stripMarker(l)));
      } else if (blockLines.length > 1) {
        chunks.push({ title: stripMarker(blockLines[0]), body: blockLines.slice(1).map(stripMarker).join(' ') });
      } else {
        chunks.push(stripMarker(blockLines[0]));
      }
    });
    return chunks;
  }

  // Most tips in this app are a single free-form sentence with no
  // separate heading ("Book a 'Reserve' ticket to skip lines and arrive
  // 45-60 minutes early..."), so a short title is synthesized by cutting
  // at the first natural break (comma/semicolon) or, failing that, the
  // first handful of words — then Title Cased.
  function extractTipTitle(text) {
    const clean = text.trim();
    const breakMatch = clean.match(/^(.{8,55}?)[,;]\s+([\s\S]*)$/);
    let titlePart, bodyPart;
    if (breakMatch) { titlePart = breakMatch[1]; bodyPart = breakMatch[2]; }
    else {
      const words = clean.split(/\s+/);
      const take = Math.min(6, words.length);
      titlePart = words.slice(0, take).join(' ');
      bodyPart = words.slice(take).join(' ');
    }
    titlePart = titlePart.replace(/^["“]|["”]$/g, '').replace(/[.:,;]+$/, '').trim();
    const smallWords = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'at', 'by', 'with', 'is', 'are']);
    const title = titlePart.split(' ').filter(Boolean).map((w, i) => {
      const lw = w.toLowerCase();
      return (i > 0 && smallWords.has(lw)) ? lw : w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
    return { title: title || clean.slice(0, 40), body: (bodyPart || clean).trim() };
  }

  function normalizeChunk(chunk) {
    if (typeof chunk === 'object') {
      return { title: chunk.title, body: chunk.body, raw: chunk.title ? `${chunk.title}. ${chunk.body}` : chunk.body };
    }
    const { title, body } = extractTipTitle(chunk);
    return { title, body, raw: chunk };
  }

  // Six colors, cycled by the card's position in the grid so a row of tips
  // reads as a lively, varied palette (blue/red/green/yellow/purple/teal) —
  // matching the reference design — rather than every card defaulting to
  // whichever single category color happens to match most often. The icon
  // *glyph* still comes from detectTipCategory (so it stays content-aware);
  // only the background/foreground color is decoupled and position-based.
  const TIP_COLOR_CYCLE = ['ticket', 'safety', 'timing', 'bag', 'photo', 'stairs'];

  function buildTipCardHtml(item, index) {
    const cat = detectTipCategory(`${item.title} ${item.body}`);
    const iconSvg = TIP_ICONS[cat.iconKey] || TIP_ICONS.bulb;
    const colorKey = TIP_COLOR_CYCLE[(index || 0) % TIP_COLOR_CYCLE.length];
    return `<div class="tip-card tip-card-titled">
      <span class="tip-card-icon tip-icon-${colorKey}">${iconSvg}</span>
      <div class="tip-card-text">
        <p class="tip-card-title">${escapeHtml(item.title)}</p>
        ${item.body ? `<p class="tip-card-body">${escapeHtml(item.body)}</p>` : ''}
      </div>
    </div>`;
  }

  // Renders a place's free-form "Tips & Tricks" text as icon-badged cards.
  // Always escapes first — never trust raw text.
  function renderDescHtml(desc) {
    if (!desc) return '';
    const chunks = splitIntoTipChunks(desc);
    if (chunks.length === 0) return '';
    const items = chunks.map(normalizeChunk).filter(it => it.title || it.body);
    if (items.length === 0) return '';

    return `<div class="tip-cards">${items.map((item, i) => buildTipCardHtml(item, i)).join('')}</div>`;
  }

  // Cards show the short description (what the place IS), never a tip —
  // tips/tricks live in `desc` and only surface in the detail modal once
  // someone taps "View insider tips". If no description has been entered yet,
  // fall back to a neutral prompt rather than silently pulling in a tip.
  function getCardBlurb(place) {
    return (place.summary || '').trim();
  }

  /* ============ Helpers ============ */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Adds a https:// scheme to a bare domain (e.g. "nps.gov/stli" ->
  // "https://nps.gov/stli") so the link works even if the user typed the
  // website without one. Returns null if there's nothing to link to.
  function normalizeWebsiteUrl(raw) {
    const t = (raw || '').trim();
    if (!t) return null;
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  }

  /* Google Maps link parsing (parseGoogleMapsLink, handleAddressPaste, pendingCoords) lives in maps-link.js. */

  /* ============ Gallery photo inputs (form) ============ */
  // Extra photo URLs for the stop being added/edited, beyond the single
  // "Cover photo". Rendered as small removable thumbnails; collected into
  // place.gallery on submit.
  let galleryUrls = [];

  function renderGalleryInputs() {
    const list = document.getElementById('galleryInputList');
    if (!list) return;
    list.innerHTML = galleryUrls.map((url, i) => `
      <div class="gallery-input-item">
        <img src="${escapeHtml(url)}" alt="Gallery photo ${i + 1}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="gallery-input-broken" style="display:none;">Broken image</div>
        <button type="button" class="gallery-input-remove" onclick="removeGalleryInput(${i})" title="Remove photo" aria-label="Remove photo ${i + 1}">×</button>
      </div>
    `).join('');
  }

  function addGalleryUrls() {
    const ta = document.getElementById('galleryUrlInput');
    if (!ta) return;
    const urls = ta.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) return;
    galleryUrls.push(...urls);
    ta.value = '';
    renderGalleryInputs();
  }

  function handleGalleryInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addGalleryUrls();
    }
  }

  function removeGalleryInput(index) {
    galleryUrls.splice(index, 1);
    renderGalleryInputs();
  }

  // A stop's card gets destroyed and recreated on every renderPlaces() call
  // (grid/route markup is rebuilt from scratch), so an exit animation has to
  // run to completion BEFORE the state change and re-render happen - there's
  // no DOM node left to animate afterward. findCardEls looks in both the
  // main grid and the My attractions grid since a given id only ever lives
  // in one of them at a time.
  function findCardEls(id) {
    return [...document.querySelectorAll(`.card[data-id="${id}"]`)];
  }

  const CARD_LEAVE_MS = 200;

  function animateCardsOut(ids) {
    const els = ids.flatMap(findCardEls);
    if (els.length === 0) return Promise.resolve();
    els.forEach(el => el.classList.add('card-leaving'));
    return new Promise(resolve => setTimeout(resolve, CARD_LEAVE_MS));
  }

  function animateCardsIn(ids) {
    ids.forEach(id => {
      findCardEls(id).forEach(el => {
        el.classList.add('card-entering');
        el.addEventListener('animationend', () => el.classList.remove('card-entering'), { once: true });
      });
    });
  }

  function getVisiblePlaces() {
    let list = currentFilter === 'all' ? places : places.filter(p => p.category === currentFilter);
    // Stops shortlisted into "My attractions" live there instead of in the
    // main list now - toggleMyList() is what moves them back and forth.
    list = list.filter(p => !isInMyList(p.id));
    const q = document.getElementById('searchInput').value.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.summary || '').toLowerCase().includes(q) ||
        (p.desc || '').toLowerCase().includes(q) ||
        (p.address || '').toLowerCase().includes(q)
      );
    }
    return list;
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerHTML = escapeHtml(msg);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function showUndoToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerHTML = `${escapeHtml(msg)} <button onclick="performUndo()">Undo</button>`;
    toast.classList.add('show');
    setTimeout(() => { if (toast.classList.contains('show')) { toast.classList.remove('show'); undoSnapshot = null; } }, 5000);
  }

  async function performUndo() {
    if (!undoSnapshot) return;
    places = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    if (undoPackagesSnapshot) {
      packages = JSON.parse(undoPackagesSnapshot);
      undoPackagesSnapshot = null;
      populatePackageSelect();
    }
    document.getElementById('toast').classList.remove('show');
    renderPlaces();
    await persistPlaces();
    announce('Change undone');
  }

  function announce(msg) {
    document.getElementById('liveRegion').textContent = msg;
  }

  // Shared cost math: given any list of places, totals up individually-priced
  // stops plus the (deduplicated) cost of every package touched by at least
  // one stop in that list. Used for both the trip-wide total and the
  // "My attractions" shortlist total below.
  function computeTotal(placesList) {
    const usedPackageIds = new Set(placesList.filter(p => p.packageId).map(p => p.packageId));
    const individualTotal = placesList.reduce((sum, p) => sum + (p.packageId ? 0 : (parseFloat(p.cost) || 0)), 0);
    const packageTotal = packages
      .filter(pkg => usedPackageIds.has(pkg.id))
      .reduce((sum, pkg) => sum + (parseFloat(pkg.cost) || 0), 0);
    return {
      total: individualTotal + packageTotal,
      usedPackageCount: usedPackageIds.size,
      packagedStopCount: placesList.filter(p => p.packageId).length
    };
  }

  function budgetTotalHtml(result) {
    const note = result.packagedStopCount
      ? `<span class="packaged-count"> (${result.usedPackageCount} package${result.usedPackageCount !== 1 ? 's' : ''}, ${result.packagedStopCount} stop${result.packagedStopCount !== 1 ? 's' : ''})</span>`
      : '';
    return `<span>Est. total</span>$${result.total.toFixed(2)}${note}`;
  }

  function updateBudgetTotal() {
    // Only count stops shortlisted in "My attractions", not every stop in the trip.
    const result = computeTotal(getMyListPlaces());
    document.getElementById('budgetTotal').innerHTML = budgetTotalHtml(result);
    const stickyValue = document.getElementById('stickyTotalValue');
    if (stickyValue) stickyValue.textContent = `$${result.total.toFixed(2)}`;
  }

  /* My attractions (shortlist) logic lives in my-list.js; the myListIds state stays here. */

  /* ============ Packages (shared prices across multiple stops) ============ */
  async function createPackage() {
    const name = window.prompt('Package name (e.g. "NYC CityPASS" or "Montauk fishing + lunch combo"):');
    if (!name || !name.trim()) return null;
    const costStr = window.prompt(`Total price for "${name.trim()}" ($):`, '0');
    if (costStr === null) return null;
    const pkg = { id: 'pkg-' + Date.now().toString() + Math.random().toString(36).slice(2), name: name.trim(), cost: parseFloat(costStr) || 0 };
    packages.push(pkg);
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package created');
    return pkg;
  }

  async function editPackage(id) {
    const pkg = packages.find(pk => pk.id === id);
    if (!pkg) return;
    const name = window.prompt('Package name:', pkg.name);
    if (!name || !name.trim()) return;
    const costStr = window.prompt(`Total price for "${name.trim()}" ($):`, pkg.cost);
    if (costStr === null) return;
    pkg.name = name.trim();
    pkg.cost = parseFloat(costStr) || 0;
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package updated');
  }

  async function deletePackage(id) {
    const pkg = packages.find(pk => pk.id === id);
    if (!pkg) return;
    const count = places.filter(p => p.packageId === id).length;
    const warning = count
      ? `Delete "${pkg.name}"? ${count} stop${count !== 1 ? 's' : ''} using it will switch to paying individually (their cost will need re-entering).`
      : `Delete "${pkg.name}"?`;
    if (!window.confirm(warning)) return;
    packages = packages.filter(pk => pk.id !== id);
    places.forEach(p => { if (p.packageId === id) p.packageId = null; });
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package deleted');
  }

  function renderPackagesBar() {
    const bar = document.getElementById('packagesBar');
    const list = document.getElementById('packagesList');
    if (!bar || !list) return;
    // With Shared trip living in the ⋮ menu, the phone-only "Packages" disclosure
    // has nothing to show when there are no packages, so hide it (see .no-packages in styles.css).
    const detailsToggle = document.getElementById('tripDetailsToggle');
    if (detailsToggle) detailsToggle.classList.toggle('no-packages', packages.length === 0);
    if (packages.length === 0) { bar.style.display = 'none'; list.innerHTML = ''; toggleTripDetails(false); return; }
    bar.style.display = 'flex';
    list.innerHTML = packages.map(pkg => {
      const count = places.filter(p => p.packageId === pkg.id).length;
      return `<span class="package-chip">
        <span class="package-chip-name">${escapeHtml(pkg.name)}</span>
        <span class="package-chip-price">$${(parseFloat(pkg.cost) || 0).toFixed(2)}</span>
        <span class="package-chip-count">${count} stop${count !== 1 ? 's' : ''}</span>
        <button type="button" class="package-chip-btn" onclick="editPackage('${pkg.id}')" title="Edit package">✎</button>
        <button type="button" class="package-chip-btn" onclick="deletePackage('${pkg.id}')" title="Delete package">×</button>
      </span>`;
    }).join('');
  }

  function populatePackageSelect(selectedId) {
    const sel = document.getElementById('placePackage');
    if (!sel) return;
    const current = selectedId !== undefined ? selectedId : sel.value;
    sel.innerHTML = '<option value="">No package — pay individually</option>' +
      packages.map(pkg => `<option value="${pkg.id}">${escapeHtml(pkg.name)} — $${(parseFloat(pkg.cost) || 0).toFixed(2)}</option>`).join('') +
      '<option value="__new__">+ New package…</option>';
    sel.value = (current && packages.some(pk => pk.id === current)) ? current : '';
    updatePackageFieldUI();
  }

  async function handlePackageSelectChange() {
    const sel = document.getElementById('placePackage');
    if (sel.value === '__new__') {
      const pkg = await createPackage();
      populatePackageSelect(pkg ? pkg.id : '');
      return;
    }
    updatePackageFieldUI();
  }

  function updatePackageFieldUI() {
    const sel = document.getElementById('placePackage');
    const costInput = document.getElementById('placeCost');
    const hint = document.getElementById('packagePriceHint');
    if (!sel || !costInput || !hint) return;
    if (sel.value && sel.value !== '__new__') {
      const pkg = packages.find(pk => pk.id === sel.value);
      costInput.value = '';
      costInput.disabled = true;
      hint.textContent = pkg ? `Priced as part of "${pkg.name}" — $${(parseFloat(pkg.cost) || 0).toFixed(2)} total, shared across every stop in it.` : '';
      hint.style.display = 'block';
    } else {
      costInput.disabled = false;
      hint.style.display = 'none';
    }
  }

  /* ============ Short description character counter (150 char max) ============ */
  const SUMMARY_MAX_LEN = 150;
  function updateSummaryCharCount() {
    const field = document.getElementById('placeSummary');
    const counter = document.getElementById('summaryCharCount');
    if (!field || !counter) return;
    const len = field.value.length;
    counter.textContent = `${len}/${SUMMARY_MAX_LEN}`;
    counter.classList.toggle('limit', len >= SUMMARY_MAX_LEN);
  }

  /* ============ Image handling (URL, or a picked file downscaled to a data URL) ============ */
  function handleImageUrlInput() {
    const url = document.getElementById('placeImage').value.trim();
    const preview = document.getElementById('imagePreview');
    if (!url) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src = url;
    preview.style.display = 'block';
  }

  /* ============ Collapsible add/edit panel ============ */
  function setAddPanelOpen(open) {
    const wrap = document.getElementById('controlPanelWrap');
    const btn = document.getElementById('addStopToggleBtn');
    const icon = document.getElementById('addStopToggleIcon');
    const label = document.getElementById('addStopToggleLabel');
    if (!wrap || !btn) return;
    wrap.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (label) label.textContent = open ? 'Close' : 'Add a stop';
    btn.setAttribute('aria-label', open ? 'Close add a stop panel' : 'Add a stop');
    if (icon) icon.innerHTML = open
      ? '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
      : '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    if (open) {
      setTimeout(() => {
        const nameField = document.getElementById('placeName');
        if (nameField) nameField.focus();
      }, 280);
    }
  }

  function isAddPanelOpen() {
    const wrap = document.getElementById('controlPanelWrap');
    return !!(wrap && wrap.classList.contains('open'));
  }

  function toggleAddPanel() {
    if (isAddPanelOpen()) {
      if (editingId) cancelEdit(); // closing manually also discards an in-progress edit
      else setAddPanelOpen(false);
    } else {
      setAddPanelOpen(true);
    }
  }

  // "Add attraction" entry in the ⋮ menu (phones): opens the add panel and scrolls to it.
  function openAddFromMenu() {
    if (activeTab !== 'explore') setTab('explore');
    toggleTripMoreMenu(false);
    if (editingId) resetForm();
    setAddPanelOpen(true);
    setTimeout(() => {
      document.getElementById('controlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  /* ============ Form (add / edit) ============ */
  async function submitForm() {
    const name = document.getElementById('placeName').value.trim();
    const category = document.getElementById('placeCategory').value;
    const day = document.getElementById('placeDay').value.trim();
    const website = document.getElementById('placeWebsite').value.trim();
    const addressRaw = document.getElementById('placeAddress').value.trim();
    const image = document.getElementById('placeImage').value.trim();
    const cost = document.getElementById('placeCost').value;
    const ratingRaw = document.getElementById('placeRating').value;
    const summary = document.getElementById('placeSummary').value.trim().slice(0, SUMMARY_MAX_LEN);
    const desc = document.getElementById('placeDesc').value.trim();
    const packageSel = document.getElementById('placePackage').value;
    const packageId = (packageSel && packageSel !== '__new__') ? packageSel : null;

    if (!name) return alert('Name is required.');

    const rating = ratingRaw === '' ? null : Math.min(5, Math.max(0, parseFloat(ratingRaw)));
    const hasValidRating = rating === null || Number.isFinite(rating);
    if (!hasValidRating) return alert('Rating must be a number between 0 and 5.');

    const dupe = places.find(p => p.name.trim().toLowerCase() === name.toLowerCase() && p.id !== editingId);
    if (dupe && !window.confirm(`"${name}" is already on this itinerary. Add it again anyway?`)) return;

    // Catch a pasted Google Maps link even if the paste event didn't fire
    // (e.g. typed/dragged in), and pull its coordinates + a clean name out
    // of it so we don't save the raw URL as the "address".
    let address = addressRaw;
    let coords = pendingCoords;
    const linkInField = parseGoogleMapsLink(addressRaw);
    if (linkInField && !linkInField.shortened) {
      coords = { lat: linkInField.lat, lng: linkInField.lng };
      if (linkInField.name) address = linkInField.name;
    }

    let placeRef;
    if (editingId) {
      const p = places.find(pl => pl.id === editingId);
      if (p) {
        const addressChanged = p.address !== address;
        p.name = name; p.category = category; p.day = day; p.website = website;
        p.address = address; p.summary = summary; p.desc = desc; p.image = image || null;
        p.cost = packageId ? null : (cost === '' ? null : parseFloat(cost));
        p.rating = rating;
        p.packageId = packageId;
        p.gallery = galleryUrls.slice();
        if (coords) { p.lat = coords.lat; p.lng = coords.lng; delete p.approxLocation; }
        else if (addressChanged) { delete p.lat; delete p.lng; delete p.approxLocation; } // stale coords for the old address
        placeRef = p;
      }
      showToast('Stop updated');
    } else {
      const newPlace = {
        id: Date.now().toString(), name, category, day, website, address, summary, desc,
        image: image || null, cost: packageId ? null : (cost === '' ? null : parseFloat(cost)), rating, packageId,
        gallery: galleryUrls.slice()
      };
      if (coords) { newPlace.lat = coords.lat; newPlace.lng = coords.lng; }
      places.push(newPlace);
      placeRef = newPlace;
      showToast('Stop added');
    }

    pendingCoords = null;
    resetForm();
    setAddPanelOpen(false);
    renderPlaces();
    await persistPlaces();
  }

  function resetForm() {
    document.getElementById('placeName').value = '';
    document.getElementById('placeCategory').value = 'sightseeing';
    document.getElementById('placeDay').value = '';
    document.getElementById('placeWebsite').value = '';
    document.getElementById('placeAddress').value = '';
    document.getElementById('placeCost').value = '';
    document.getElementById('placeRating').value = '';
    document.getElementById('placeSummary').value = '';
    updateSummaryCharCount();
    document.getElementById('placeDesc').value = '';
    document.getElementById('placeImage').value = '';
    const preview = document.getElementById('imagePreview');
    preview.style.display = 'none';
    preview.removeAttribute('src');
    populatePackageSelect('');
    galleryUrls = [];
    renderGalleryInputs();
    editingId = null;
    document.getElementById('formTitle').textContent = 'Add a stop';
    document.getElementById('editBadge').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('submitBtn').innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg> Add stop';
  }

  function startEdit(id) {
    if (activeTab !== 'explore') setTab('explore');
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    editingId = id;
    document.getElementById('placeName').value = p.name;
    document.getElementById('placeCategory').value = p.category;
    document.getElementById('placeDay').value = p.day || '';
    document.getElementById('placeWebsite').value = p.website || '';
    document.getElementById('placeAddress').value = p.address || '';
    document.getElementById('placeCost').value = p.cost != null ? p.cost : '';
    document.getElementById('placeRating').value = p.rating != null ? p.rating : '';
    populatePackageSelect(p.packageId || '');
    document.getElementById('placeSummary').value = p.summary || '';
    updateSummaryCharCount();
    document.getElementById('placeDesc').value = p.desc || '';
    document.getElementById('placeImage').value = p.image || '';
    const preview = document.getElementById('imagePreview');
    if (p.image) { preview.src = p.image; preview.style.display = 'block'; } else { preview.style.display = 'none'; preview.removeAttribute('src'); }
    galleryUrls = Array.isArray(p.gallery) ? p.gallery.slice() : [];
    renderGalleryInputs();

    document.getElementById('formTitle').textContent = 'Edit stop';
    document.getElementById('editBadge').style.display = 'inline-block';
    document.getElementById('cancelBtn').style.display = 'inline-block';
    document.getElementById('submitBtn').textContent = 'Save changes';
    setAddPanelOpen(true);
    setTimeout(() => {
      document.getElementById('controlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function cancelEdit() { resetForm(); setAddPanelOpen(false); }

  /* ============ Delete (inline confirm + undo) ============ */
  async function requestDelete(id) {
    if (confirmingDeleteId === id) {
      const removed = places.find(p => p.id === id);
      undoSnapshot = JSON.stringify(places);
      places = places.filter(p => p.id !== id);
      confirmingDeleteId = null;
      renderPlaces();
      await persistPlaces();
      announce(`${removed ? removed.name : 'Stop'} removed`);
      showUndoToast('Stop removed');
    } else {
      confirmingDeleteId = id;
      renderPlaces();
      setTimeout(() => { if (confirmingDeleteId === id) { confirmingDeleteId = null; renderPlaces(); } }, 3000);
    }
  }

  /* Reordering (drag & drop, moveStop) lives in drag-drop.js, along with its drag state. */

  /* ============ Optimize Route (per day-group nearest-neighbor reorder) ============ */
  // Reorders the stops within a single day group ("Day 1", "Unscheduled", ...) so that,
  // starting from whichever stop is currently first in that group, each next stop is the
  // closest not-yet-visited stop - the same nearest-neighbor approach as the Route helper
  // on the map (nearest.js), just applied in-place to one day's stops instead of building
  // a separate tour. Stops with no lat/lng can't be distance-ranked, so they're left in
  // place at the end of the group rather than blocking the whole optimization.
  async function optimizeRoute(dayKey) {
    if (typeof hasCoords !== 'function' || typeof tourLegKm !== 'function') return; // nearest.js not loaded
    const indices = [];
    places.forEach((p, i) => {
      const key = (p.day && p.day.trim()) ? p.day.trim() : UNSCHEDULED_KEY;
      if (key === dayKey) indices.push(i);
    });
    if (indices.length < 2) { showToast('Need at least two stops to optimize'); return; }

    const groupPlaces = indices.map(i => places[i]);
    const located = groupPlaces.filter(hasCoords);
    const unlocated = groupPlaces.filter(p => !hasCoords(p));
    if (located.length < 2) { showToast('Not enough located stops in this day to optimize'); return; }

    const ordered = [located[0]];
    const remaining = located.slice(1);
    while (remaining.length) {
      const cur = ordered[ordered.length - 1];
      let bestIdx = 0, bestKm = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const km = tourLegKm(cur, remaining[i]);
        if (km < bestKm) { bestKm = km; bestIdx = i; }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }

    const newGroupOrder = [...ordered, ...unlocated];
    undoSnapshot = JSON.stringify(places);
    indices.forEach((origIdx, pos) => { places[origIdx] = newGroupOrder[pos]; });
    renderPlaces();
    await persistPlaces();
    const label = dayKey === UNSCHEDULED_KEY ? 'Unscheduled' : dayKey;
    showUndoToast(`Optimized route for ${label}`);
  }

    function handleCardKeydown(e, id) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveStop(id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a')) {
      e.preventDefault();
      const p = places.find(pl => pl.id === id);
      if (p && p.desc) openDetailModal(id);
    }
  }

  // Ignore clicks on anything interactive (buttons, links, drag handle,
  // star rating) — those already handle themselves — and open the detail
  // modal for everything else, so the whole card is the "view details"
  // trigger instead of one small button competing for space.
  function handleCardClick(e, id, hasDesc) {
    if (!hasDesc) return;
    if (e.target.closest('button, a')) return;
    openDetailModal(id);
  }

  /* ============ Rendering ============ */
  const CATEGORY_LABELS = {
    sightseeing: 'Attractions',
    dining: 'Food & Drink',
    outdoors: 'Outdoors & Nature',
    skyscrapers: 'City & Architecture',
    'museums-culture': 'Culture & Museums',
    'entertainment-nightlife': 'Entertainment & Nightlife',
    shopping: 'Shopping',
    'viewpoints-photography': 'Views & Photography'
  };
  function categoryLabel(category) { return CATEGORY_LABELS[category] || category; }

  function categoryDotColor(category) {
    return {
      dining: 'var(--tag-dining)',
      sightseeing: 'var(--tag-sightseeing)',
      outdoors: 'var(--tag-outdoors)',
      skyscrapers: 'var(--tag-skyscrapers)',
      'museums-culture': 'var(--tag-museums)',
      'entertainment-nightlife': 'var(--tag-entertainment)',
      shopping: 'var(--tag-shopping)',
      'viewpoints-photography': 'var(--tag-viewpoints)'
    }[category];
  }

  // Rating lives directly on the card/route item as clickable stars — no
  // need to open Edit just to rate a stop. Clicking a star sets a whole
  // number; clicking the currently-set star again clears it. There's no way
  // to pull a live aggregate from Google/Yelp here — this artifact runs in
  // a sandboxed iframe that blocks fetch() to third-party APIs (same reason
  // coordinates come from pasted Maps links instead of geocoding) — so this
  // is the trip owner's own rating, with an optional exact-score field in
  // the form for typing a precise decimal (e.g. copying a real 4.7).
  function formatRating(rating) {
    const n = parseFloat(rating);
    return Number.isFinite(n) ? n.toFixed(1) : null;
  }

  const CARD_STAR_SVG = '<svg width="21" height="21" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.6l2.53 5.13 5.66.82-4.1 4 .97 5.65L10 14.9l-5.06 2.3.97-5.65-4.1-4 5.66-.82L10 1.6z"/></svg>';
  const BOOKMARK_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h8a1 1 0 0 1 1 1V14l-5-3-5 3V3.5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const REMOVE_FROM_LIST_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  // Small link/action icons reused across the grid card, route item, and
  // detail modal — hoisted here once instead of pasted inline at each spot.
  const SHOW_ON_MAP_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="9" r="2.4" stroke="currentColor" stroke-width="1.7"/></svg>';
  const MAP_PIN_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>';
  const WEBSITE_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8c2.4 2.6 3.7 5.9 3.7 9.2s-1.3 6.6-3.7 9.2M12 2.8c-2.4 2.6-3.7 5.9-3.7 9.2s1.3 6.6 3.7 9.2M2.8 12h18.4" stroke="currentColor" stroke-width="1.4"/></svg>';
  const READMORE_CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  async function rateStop(id, value) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    // Clicking the already-committed star again clears the rating.
    p.rating = (p.rating != null && Math.round(p.rating) === value) ? null : value;
    renderPlaces();
    if (detailModalTriggerId === id) {
      const starRow = document.querySelector('#detailModalBody .detail-modal-star-row');
      if (starRow) starRow.innerHTML = buildStarRowHtml(p);
    }
    await persistPlaces();
    announce(p.rating != null ? `${p.name} rated ${p.rating} star${p.rating === 1 ? '' : 's'}` : `${p.name} rating cleared`);
  }

  function buildStarRowHtml(place) {
    const rounded = place.rating != null ? Math.round(place.rating) : 0;
    let buttons = '';
    for (let v = 5; v >= 1; v--) {
      buttons += `<button type="button" class="card-star-btn ${v <= rounded ? 'filled' : ''}" onclick="event.stopPropagation(); rateStop('${place.id}', ${v})" title="Rate ${v} star${v > 1 ? 's' : ''}" aria-label="Rate ${v} star${v > 1 ? 's' : ''}">${CARD_STAR_SVG}</button>`;
    }
    const formatted = place.rating != null ? formatRating(place.rating) : null;
    const valueLabel = formatted !== null
      ? `<span class="card-star-value">${formatted}</span>`
      : `<span class="card-star-value muted">Unrated</span>`;
    return `<div class="card-star-row" role="radiogroup" aria-label="Your rating for ${escapeHtml(place.name)}"><div class="card-star-buttons">${buttons}</div>${valueLabel}</div>`;
  }

  /* ============ Detail modal (full-screen image + all tips/notes) ============ */
  let detailModalTriggerId = null; // which stop's button opened the modal, so focus can return to it

  // Three-column strip (provider/category, price, location) shown at the
  // top of the detail modal — a quick-glance summary before the tips.
  function buildInfoBarHtml(p) {
    const placePkg = p.packageId ? packages.find(pk => pk.id === p.packageId) : null;
    const websiteUrl = normalizeWebsiteUrl(p.website);

    const col1Icon = placePkg ? TIP_ICONS.ticket : TIP_ICONS.bulb;
    const col1Label = placePkg ? placePkg.name : categoryLabel(p.category);
    const col1Sub = websiteUrl ? 'Official website' : 'Category';
    const col1TextInner = `<div class="detail-info-label" title="${escapeHtml(col1Label)}">${escapeHtml(col1Label)}</div><div class="detail-info-sub">${escapeHtml(col1Sub)}</div>`;
    const col1Text = websiteUrl
      ? `<a class="detail-info-text detail-info-link" href="${websiteUrl}" target="_blank" rel="noopener" title="Official website">${col1TextInner}</a>`
      : `<div class="detail-info-text">${col1TextInner}</div>`;

    const priceVal = placePkg ? (parseFloat(placePkg.cost) || 0) : (p.cost != null && p.cost !== '' ? parseFloat(p.cost) : null);
    const col2Label = priceVal == null ? '—' : (priceVal === 0 ? 'Free' : `$${priceVal.toFixed(2)}`);
    const col2Sub = placePkg ? 'Total price' : 'Price';

    const col3Label = p.address ? p.address : 'No address added';
    const col3Sub = 'Location';
    const col3MapsUrl = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : null;
    const col3TextInner = `<div class="detail-info-label" title="${escapeHtml(col3Label)}">${escapeHtml(col3Label)}</div><div class="detail-info-sub">${escapeHtml(col3Sub)}</div>`;
    const col3Text = col3MapsUrl
      ? `<a class="detail-info-text detail-info-link" href="${col3MapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">${col3TextInner}</a>`
      : `<div class="detail-info-text">${col3TextInner}</div>`;

    return `<div class="detail-info-bar">
      <div class="detail-info-item"><span class="detail-info-icon">${col1Icon}</span>${col1Text}</div>
      <div class="detail-info-divider"></div>
      <div class="detail-info-item"><span class="detail-info-icon">${TIP_ICONS.coin}</span><div class="detail-info-text"><div class="detail-info-label">${escapeHtml(col2Label)}</div><div class="detail-info-sub">${escapeHtml(col2Sub)}</div></div></div>
      <div class="detail-info-divider"></div>
      <div class="detail-info-item"><span class="detail-info-icon">${TIP_ICONS.pin}</span>${col3Text}</div>
    </div>`;
  }

  function openDetailModal(id) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    const overlay = document.getElementById('detailModalOverlay');
    const body = document.getElementById('detailModalBody');
    if (!overlay || !body) return;

    const mapsUrl = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : null;
    const websiteUrl = normalizeWebsiteUrl(p.website);
    const placePkg = p.packageId ? packages.find(pk => pk.id === p.packageId) : null;
    const galleryPhotos = [p.image, ...((Array.isArray(p.gallery) ? p.gallery : []))].filter(Boolean);
    const imageMarkup = p.image
      ? `<img class="detail-modal-image" src="${p.image}" alt="${escapeHtml(p.name)}" style="cursor:zoom-in;" onclick="openLightbox('${p.id}', 0)">`
      : `<div class="detail-modal-image-placeholder hero-placeholder">
           <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`;
    const galleryStripHtml = galleryPhotos.length > 1
      ? `<div class="detail-gallery-strip">${galleryPhotos.map((url, i) => `
          <button type="button" class="detail-gallery-thumb${i === 0 ? ' active' : ''}" onclick="openLightbox('${p.id}', ${i})" title="View photo ${i + 1}">
            <img src="${escapeHtml(url)}" alt="Photo ${i + 1} of ${escapeHtml(p.name)}" onerror="this.parentElement.style.display='none'">
          </button>`).join('')}</div>`
      : '';

    body.innerHTML = `
      <div class="detail-modal-hero">
        ${imageMarkup}
        <div class="detail-modal-hero-scrim" aria-hidden="true"></div>
        <div class="detail-modal-hero-content">
          ${placePkg ? `<span class="detail-modal-hero-badge">${TIP_ICONS.ticket}${escapeHtml(placePkg.name)} · $${(parseFloat(placePkg.cost) || 0).toFixed(2)} total</span>` : ''}
          <h2 class="detail-modal-hero-title" id="detailModalTitle">${escapeHtml(p.name)}</h2>
          ${p.day ? `<div class="detail-modal-hero-day">${escapeHtml(p.day)}</div>` : ''}
          <div class="detail-modal-star-row star-row-on-image">${buildStarRowHtml(p)}</div>
        </div>
      </div>
      ${galleryStripHtml}
      <div class="detail-modal-content">
        ${buildInfoBarHtml(p)}
        ${p.summary ? `<p class="detail-modal-summary">${escapeHtml(p.summary)}</p>` : ''}
        <h3 class="detail-modal-desc-heading"><span class="detail-modal-desc-heading-icon">${TIP_ICONS.bulb}</span>Tips &amp; Tricks</h3>
        <div class="detail-modal-desc">${p.desc ? renderDescHtml(p.desc) : 'No tips added yet.'}</div>
      </div>
    `;

    detailModalTriggerId = id;
    overlay.classList.add('open');
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', handleDetailModalKeydown);
    const closeBtn = document.getElementById('detailModalCloseBtn');
    if (closeBtn) closeBtn.focus();
  }

  function closeDetailModal() {
    const overlay = document.getElementById('detailModalOverlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', handleDetailModalKeydown);
    if (detailModalTriggerId) {
      const el = document.querySelector(`.card[data-id="${detailModalTriggerId}"], .route-item[data-id="${detailModalTriggerId}"]`);
      if (el) el.focus();
    }
    detailModalTriggerId = null;
  }

  function handleDetailModalKeydown(e) {
    if (e.key === 'Escape') closeDetailModal();
  }

  /* ============ Lightbox (full-screen gallery viewer) ============ */
  let lightboxPhotos = [];
  let lightboxIndex = 0;

  function openLightbox(placeId, startIndex) {
    const p = places.find(pl => pl.id === placeId);
    if (!p) return;
    lightboxPhotos = [p.image, ...((Array.isArray(p.gallery) ? p.gallery : []))].filter(Boolean);
    if (lightboxPhotos.length === 0) return;
    lightboxIndex = Math.min(Math.max(startIndex || 0, 0), lightboxPhotos.length - 1);
    renderLightbox();
    document.getElementById('lightboxOverlay').classList.add('open');
    document.addEventListener('keydown', handleLightboxKeydown);
  }

  function renderLightbox() {
    const img = document.getElementById('lightboxImage');
    const counter = document.getElementById('lightboxCounter');
    if (!img || !counter) return;
    img.src = lightboxPhotos[lightboxIndex];
    img.alt = `Photo ${lightboxIndex + 1} of ${lightboxPhotos.length}`;
    counter.textContent = lightboxPhotos.length > 1 ? `${lightboxIndex + 1} / ${lightboxPhotos.length}` : '';
    document.querySelectorAll('.detail-gallery-thumb').forEach((el, i) => el.classList.toggle('active', i === lightboxIndex));
    const multi = lightboxPhotos.length > 1;
    document.querySelector('.lightbox-prev').style.display = multi ? 'flex' : 'none';
    document.querySelector('.lightbox-next').style.display = multi ? 'flex' : 'none';
  }

  function lightboxStep(delta) {
    if (lightboxPhotos.length === 0) return;
    lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length;
    renderLightbox();
  }

  function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', handleLightboxKeydown);
  }

  function handleLightboxKeydown(e) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lightboxStep(-1);
    else if (e.key === 'ArrowRight') lightboxStep(1);
  }

  function buildCardEl(place, globalIndex, visible, opts = {}) {
    const mobileUI = isMobileUI();
    // HTML5 drag-and-drop (dragstart/dragover/drop) is a mouse-era API: touch
    // browsers either ignore it or fire it inconsistently, and a draggable
    // element under a finger also fights the page's own scroll gesture. So on
    // touch/narrow screens we don't mark cards draggable at all — reordering
    // instead happens through the Up/Down buttons rendered below, which call
    // the same moveStop() the keyboard shortcut already uses.
    const draggableCard = opts.draggable !== false && !mobileUI;
    const reorderableCard = opts.draggable !== false; // true whenever this card belongs to the orderable list, drag or not
    const context = opts.context === 'mylist' ? 'mylist' : 'database'; // 'mylist' cards get a single unambiguous "remove from list" action instead of edit/delete
    const card = document.createElement('div');
    card.className = 'card' + (place.desc ? ' has-desc' : '');
    card.dataset.id = place.id;
    card.draggable = draggableCard;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${place.name}, stop ${globalIndex + 1}.${place.desc ? ' Press Enter for full details.' : ''}${draggableCard ? ' Press Alt plus arrow keys to reorder.' : ''}`);

    card.addEventListener('click', (e) => handleCardClick(e, place.id, !!place.desc));
    // Hovering/focusing a card highlights its pin whenever a map is on screen
    // (e.g. the My attractions cards sitting above the Map / Split view).
    card.addEventListener('mouseenter', () => highlightPin(place.id, true));
    card.addEventListener('mouseleave', () => highlightPin(place.id, false));
    card.addEventListener('focus', () => highlightPin(place.id, true));
    card.addEventListener('blur', () => highlightPin(place.id, false));
    if (draggableCard) {
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragend', handleDragEnd);
      card.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));
    } else if (reorderableCard) {
      // Mobile: no drag handlers, but Alt+Arrow keyboard reordering still
      // works for anyone with a hardware keyboard (e.g. a connected iPad).
      card.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));
    } else {
      // Cards rendered in the "My attractions" shortlist aren't part of the
      // draggable trip-order list, but Enter should still open full details.
      card.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a')) {
          e.preventDefault();
          if (place.desc) openDetailModal(place.id);
        }
      });
    }

    const idxInVisible = visible.findIndex(p => p.id === place.id);
    const isFirst = idxInVisible === 0;
    const isLast = idxInVisible === visible.length - 1;
    const isConfirming = confirmingDeleteId === place.id;

    const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
    const cardCostValue = placePkg ? (parseFloat(placePkg.cost) || 0) : (place.cost != null && place.cost !== '' ? parseFloat(place.cost) : null);
    const cardPriceBadgeHtml = cardCostValue != null
      ? `<span class="price-badge${cardCostValue === 0 ? ' free' : ''}">${cardCostValue === 0 ? 'Free' : '$' + cardCostValue.toFixed(2)}</span>`
      : '';

    const categoryBadge = `<span class="category-tag card-badge tag-${place.category}">${categoryLabel(place.category)}</span>`;
    const imageMarkup = `<div class="card-image-wrap">${place.image
      ? `<img class="card-image" src="${place.image}" alt="${escapeHtml(place.name)}" draggable="false">`
      : `<div class="card-image-placeholder" draggable="false">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`}${categoryBadge}${cardPriceBadgeHtml}</div>`;

    const mapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
    const websiteUrl = normalizeWebsiteUrl(place.website);
    const canShowOnMap = !!((place.address && place.address.trim()) || (typeof place.lat === 'number' && typeof place.lng === 'number'));
    const hasBottomBlock = !!(mapsUrl || canShowOnMap || websiteUrl || place.desc);

    card.innerHTML = `
      ${imageMarkup}
      <div class="card-body">
        <div class="card-main">
        <div class="card-header">
          <h3 class="card-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h3>
        </div>
        <div class="card-desc-wrap">
          <div class="card-desc">${getCardBlurb(place) ? escapeHtml(getCardBlurb(place)) : 'No description added.'}</div>
        </div>
        <div class="card-bottom-block${hasBottomBlock ? ' has-content' : ''}">
        ${(mapsUrl || canShowOnMap) ? `<div class="directions-links">
          ${canShowOnMap ? `<button type="button" class="card-address card-address-btn" onclick="event.stopPropagation(); showOnMap('${place.id}')" title="Show this stop on the map in this app" aria-label="Show ${escapeHtml(place.name)} on the map in this app">
            ${MAP_PIN_ICON_SVG}
            <span class="card-address-text">Show on map</span>
          </button>` : ''}
          ${mapsUrl ? `<a class="card-address" href="${mapsUrl}" target="_blank" rel="noopener" title="Open ${escapeHtml(place.address)} in Google Maps">
            ${WEBSITE_ICON_SVG}
            <span class="card-address-text">Google Maps ↗</span>
          </a>` : ''}
        </div>` : ''}
        ${websiteUrl ? `<a class="card-website" href="${websiteUrl}" target="_blank" rel="noopener" title="Official website (opening times, tickets, etc.)">
          ${WEBSITE_ICON_SVG}
          Official website<span class="link-arrow">↗</span>
        </a>` : ''}
        ${place.desc ? `<div class="card-cta"><div class="card-readmore-inline">View insider tips${READMORE_CHEVRON_SVG}</div></div>` : ''}
        </div>
        </div>
        <div class="card-footer${context === 'mylist' ? ' mylist-footer' : ''}">
          ${context === 'mylist' ? `
          ${buildStarRowHtml(place)}
          <div class="footer-actions">
            <button type="button" class="icon-text-btn danger mylist-remove-btn" onclick="event.stopPropagation(); toggleMyList('${place.id}')" title="Remove from My attractions" aria-label="Remove ${escapeHtml(place.name)} from My attractions">
              ${REMOVE_FROM_LIST_ICON_SVG} Remove from list
            </button>
          </div>
          ` : `
          ${buildStarRowHtml(place)}
          <div class="footer-actions-row">
            ${reorderableCard && mobileUI ? `
            <div class="mobile-reorder-btns">
              <button type="button" class="icon-only-btn reorder-btn" onclick="event.stopPropagation(); moveStop('${place.id}', -1)" ${isFirst ? 'disabled' : ''} title="Move up" aria-label="Move ${escapeHtml(place.name)} up">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 12.5V3.5M8 3.5L3.5 8M8 3.5L12.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="icon-only-btn reorder-btn" onclick="event.stopPropagation(); moveStop('${place.id}', 1)" ${isLast ? 'disabled' : ''} title="Move down" aria-label="Move ${escapeHtml(place.name)} down">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M8 12.5L3.5 8M8 12.5L12.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>` : ''}
            <button class="icon-only-btn mylist-btn ${isInMyList(place.id) ? 'active' : ''}" onclick="event.stopPropagation(); toggleMyList('${place.id}')" title="${isInMyList(place.id) ? 'Remove from My attractions' : 'Add to my list'}" aria-label="${isInMyList(place.id) ? 'Remove ' + escapeHtml(place.name) + ' from My attractions' : 'Add ' + escapeHtml(place.name) + ' to My attractions'}">
              ${BOOKMARK_ICON_SVG}
            </button>
            <button class="icon-only-btn edit-btn" onclick="event.stopPropagation(); startEdit('${place.id}')" title="Edit stop" aria-label="Edit ${escapeHtml(place.name)}">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8.5 8.5L2 14l0.5-3.5L11 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-only-btn delete-btn ${isConfirming ? 'confirming' : ''}" onclick="event.stopPropagation(); requestDelete('${place.id}')" title="${isConfirming ? 'Click again to confirm deletion' : 'Delete stop (removes it entirely, not just from My attractions)'}" aria-label="${isConfirming ? 'Confirm deletion of ' + escapeHtml(place.name) : 'Delete ' + escapeHtml(place.name) + ' entirely'}">
              ${isConfirming
                ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l0.6 8.4a1 1 0 0 0 1 0.9h3.8a1 1 0 0 0 1-0.9l0.6-8.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
            </button>
          </div>
          `}
        </div>
      </div>
    `;

    return card;
  }

  function renderEmptyState(container, reason) {
    const messages = {
      filter: ['No stops in this category', 'Try a different filter, or add a new stop above.'],
      search: ['No matches', 'Try a different search term.'],
      none: ['No stops yet', 'Add your first place above to start building the route.'],
      inMyList: ['All set!', 'Every stop has been added to My attractions - open that tab and remove one to see it here again.']
    };
    const [lead, sub] = messages[reason];
    container.innerHTML = `
      <div class="empty-state">
        <div class="glyph">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" stroke="#0d9488" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <p class="lead">${lead}</p>
        <p>${sub}</p>
      </div>`;
  }

  function renderGridView(container, visible) {
    const groupByDay = document.getElementById('groupByDayToggle').checked;

    if (!groupByDay) {
      const grid = document.createElement('div');
      grid.className = 'grid-container';
      visible.forEach(place => {
        const gi = places.findIndex(p => p.id === place.id);
        grid.appendChild(buildCardEl(place, gi, visible));
      });
      grid.appendChild(buildEndDropZone());
      grid.addEventListener('dragover', handleContainerDragOver);
      grid.addEventListener('drop', handleContainerDrop);
      container.appendChild(grid);
      return;
    }

    const groups = []; const groupMap = {};
    visible.forEach(place => {
      const key = place.day && place.day.trim() ? place.day.trim() : UNSCHEDULED_KEY;
      if (!groupMap[key]) { groupMap[key] = []; groups.push(key); }
      groupMap[key].push(place);
    });

    groups.forEach((key) => {
      const wrap = document.createElement('div');
      wrap.className = 'day-group';
      const title = document.createElement('h3');
      title.className = 'day-group-title';
      title.innerHTML = `${escapeHtml(key)} <span class="count">${groupMap[key].length} stop${groupMap[key].length > 1 ? 's' : ''}</span>`;
      if (groupMap[key].length >= 2) {
        const optimizeBtn = document.createElement('button');
        optimizeBtn.type = 'button';
        optimizeBtn.className = 'icon-text-btn optimize-route-btn';
        optimizeBtn.title = "Reorder this day's stops to minimize walking distance between them";
        optimizeBtn.textContent = 'Optimize Route';
        optimizeBtn.addEventListener('click', () => optimizeRoute(key));
        title.appendChild(optimizeBtn);
      }
      wrap.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'grid-container';
      grid.dataset.groupKey = key; // lets drag handlers know which day a drop here should assign
      groupMap[key].forEach(place => {
        const gi = places.findIndex(p => p.id === place.id);
        grid.appendChild(buildCardEl(place, gi, visible));
      });
      // Every group gets its own end-drop-zone (not just the last one) so
      // you can drop into any group's empty space, or into a group that's
      // momentarily empty because its only card is the one being dragged.
      grid.appendChild(buildEndDropZone());
      grid.addEventListener('dragover', handleContainerDragOver);
      grid.addEventListener('drop', handleContainerDrop);
      wrap.appendChild(grid);
      container.appendChild(wrap);
    });
  }

  function renderPlaces() {
    if (!isLoading) pruneMyList();
    document.body.classList.toggle('map-fullscreen', currentView !== 'grid' && !isLoading);
    viewContainer.innerHTML = '';
    updateBudgetTotal();
    renderPackagesBar();
    renderMyList();
    document.body.classList.toggle('mylist-mapview', activeTab === 'mylist' && currentView !== 'grid');
    if (activeTab === 'mylist' && !isLoading) {
      // My attractions: Grid = the list cards above; Map/Split = a map of only the list's stops.
      if (currentView === 'map') renderMapView(viewContainer, []);
      else if (currentView === 'split') renderSplitView(viewContainer, []);
      return;
    }

    if (isLoading) {
      const grid = document.createElement('div');
      grid.className = 'grid-container';
      for (let i = 0; i < 3; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'card';
        skeleton.style.height = '230px';
        skeleton.style.background = 'linear-gradient(90deg, #f1f3f6 25%, #f8f9fb 37%, #f1f3f6 63%)';
        skeleton.style.backgroundSize = '400% 100%';
        skeleton.style.animation = 'shimmer 1.4s ease infinite';
        grid.appendChild(skeleton);
      }
      viewContainer.appendChild(grid);
      return;
    }

    const visible = getVisiblePlaces();

    // In Map view, shortlisted stops are still drawn, so an all-shortlisted trip isn't "empty" there.
    const mapHasMyList = (currentView === 'map' || currentView === 'split') && getMyListPlaces().length > 0;
    if (visible.length === 0 && !mapHasMyList) {
      const q = document.getElementById('searchInput').value.trim();
      let reason;
      if (places.length === 0) reason = 'none';
      else if (q) reason = 'search';
      else if (currentFilter !== 'all') reason = 'filter';
      else reason = 'inMyList';
      renderEmptyState(viewContainer, reason);
      return;
    }

    if (currentView === 'map') renderMapView(viewContainer, visible);
    else if (currentView === 'split') renderSplitView(viewContainer, visible);
    else renderGridView(viewContainer, visible);

    if (lastFocusId) {
      const el = viewContainer.querySelector(`[data-id="${lastFocusId}"]`);
      if (el) el.focus();
      lastFocusId = null;
    }
  }

  /* ============ Toolbar events ============ */
  const filterMoreWrap = document.getElementById('filterMore');
  const filterMoreToggle = document.getElementById('filterMoreToggle');
  const filterMoreLabel = document.getElementById('filterMoreLabel');
  const filterMoreDefaultLabel = filterMoreLabel ? filterMoreLabel.textContent : 'More';

  document.getElementById('filterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll('#filterGroup .pill-btn').forEach(b => b.classList.toggle('active', b === btn));

    // Keep the "More" toggle (mobile only) in sync: show the picked
    // category's name and highlight it when the active filter lives inside
    // the dropdown; otherwise reset it back to its default label.
    if (filterMoreWrap && filterMoreToggle && filterMoreLabel) {
      const pickedInMenu = filterMoreWrap.contains(btn);
      filterMoreToggle.classList.toggle('active', pickedInMenu);
      filterMoreLabel.textContent = pickedInMenu ? btn.textContent : filterMoreDefaultLabel;
      filterMoreWrap.classList.remove('open');
      filterMoreToggle.setAttribute('aria-expanded', 'false');
    }

    renderFilterMenu();
    renderPlaces();
  });

  if (filterMoreWrap && filterMoreToggle) {
    filterMoreToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = filterMoreWrap.classList.toggle('open');
      filterMoreToggle.setAttribute('aria-expanded', String(isOpen));
    });
    // Close the dropdown on any click elsewhere on the page.
    document.addEventListener('click', (e) => {
      if (!filterMoreWrap.contains(e.target)) {
        filterMoreWrap.classList.remove('open');
        filterMoreToggle.setAttribute('aria-expanded', 'false');
      }
    });
    // Close on Escape for keyboard users.
    filterMoreWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        filterMoreWrap.classList.remove('open');
        filterMoreToggle.setAttribute('aria-expanded', 'false');
        filterMoreToggle.focus();
      }
    });
  }

  document.getElementById('viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    setView(btn.dataset.view);
  });

  // Also used by showOnMap() (map-view.js) to jump into the split view.
  function setView(view) {
    currentView = view;
    document.querySelectorAll('#viewToggle .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    renderViewMenu();
    renderPlaces();
  }

  const styleSheet = document.createElement('style');
  styleSheet.textContent = '@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }';
  document.head.appendChild(styleSheet);

  /* ============ Init ============ */
  (async function init() {
    renderFilterMenu();
    renderViewMenu();
    await loadTripsIndex();
    currentTripId = trips[0].id;
    renderTripSelect();
    await loadCurrentTripPlaces();
  })();

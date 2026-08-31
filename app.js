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
  let trips = [];              // [{id, name, shared}]
  let currentTripId = null;

  let currentFilter = 'all';
  let currentView = 'grid';
  let editingId = null;
  let confirmingDeleteId = null;
  let draggedId = null;
  let dragOverEl = null;
  let dragStartSnapshot = null; // places order when the drag began, for cancel/undo
  let dropHappened = false;     // did a drop actually complete this drag?
  let isLoading = true;
  let lastFocusId = null;
  let undoSnapshot = null;
  let undoPackagesSnapshot = null; // only set when an action also changes packages[]

  const viewContainer = document.getElementById('viewContainer');
  const TRIPS_INDEX_KEY = 'trips-index';
  const UNSCHEDULED_KEY = 'Unscheduled'; // group key used for stops with no "day" set

  const SAMPLE_PLACES = [
    { id: "s2", name: "Statue of Liberty", category: "sightseeing", day: "", time: "09:00–18:30", address: "Liberty Island, New York, NY 10004", desc: "Statue of Liberty takes about 4 to 5 hours to complete the full tour, including travel and security.", image: "images/1.jpg", cost: null, travelNext: "", packageId: "pkg-1788129485954n4a8xunrpce" },
    { id: "s3", name: "New York Crown", category: "sightseeing", day: "", time: "09:00–18:30", address: "Liberty Island, New York, NY 10004", desc: "Access to the interior (pedestal or crown) requires specialized tickets that often sell out 4 to 6 months in advance.", image: "images/2.jpg", cost: 0.3, travelNext: "", packageId: null },
    { id: "1788127853367", name: "Ellis Island National Museum of Immigration", category: "sightseeing", day: "", time: "8:30 to 6:30", address: "Ellis Island, New York, NY 10004", desc: "General admission includes the museum and the documentary film. If you want a unique experience, look into booking the 90-minute Hard Hat Tour of the abandoned immigrant hospital complex. You can also search for family arrival records at the American Family Immigration History Center.", image: "images/3.jpg", cost: null, travelNext: "", packageId: "pkg-1788129485954n4a8xunrpce" },
    { id: "s1", name: "Empire State Building", category: "sightseeing", day: "", time: "9:00 to 12:00", address: "20 W 34th St., New York, NY 10001", desc: "There are multiple ticket tiers. The standard ticket gets you to the 86th-floor open-air observatory. It is highly recommended to buy tickets in advance to skip the standard ticket purchasing line. Plan for about 1.5 to 2 hours for the visit.", image: "images/4.jpg", cost: 44, travelNext: "", packageId: null },
    { id: "1788179669671", name: "Times Square", category: "outdoors", day: "", time: "24 hours a day", address: "Manhattan, NY 10036", desc: "Visiting after dark is a must to really experience the famous glowing billboards and neon lights. It is an incredible environment to bring your Sony α6600 out for some dynamic, high-contrast night photography. Expect heavy crowds, costumed street performers, and a very fast-paced atmosphere.", image: "images/5.jpg", cost: 0, travelNext: "", packageId: null }
  ];

  const SAMPLE_PACKAGES = [
    { id: "pkg-1788129485954n4a8xunrpce", name: "Statue City Cruises", cost: 26 }
  ];

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
        if (Array.isArray(parsed)) { places = parsed; packages = []; }
        else { places = Array.isArray(parsed.places) ? parsed.places : []; packages = Array.isArray(parsed.packages) ? parsed.packages : []; }
      } else {
        places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
        packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
        await persistPlaces();
      }
    } catch (e) {
      places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
      packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
      await persistPlaces();
    }
    isLoading = false;
    populatePackageSelect();
    renderPlaces();
  }

  async function persistPlaces() {
    const trip = currentTrip();
    if (!trip) return;
    const indicator = document.getElementById('saveIndicator');
    const text = document.getElementById('saveText');
    indicator.classList.add('saving');
    text.textContent = 'Saving...';
    try {
      await window.storage.set(tripPlacesKey(trip.id), JSON.stringify({ places, packages }), !!trip.shared);
      text.textContent = 'Saved';
    } catch (e) {
      text.textContent = 'Save failed';
    }
    setTimeout(() => indicator.classList.remove('saving'), 600);
    updateBudgetTotal();
  }

  /* ============ Trip management ============ */
  function renderTripSelect() {
    const select = document.getElementById('tripSelect');
    select.innerHTML = trips.map(t => `<option value="${t.id}" ${t.id === currentTripId ? 'selected' : ''}>${escapeHtml(t.name)}${t.shared ? ' (shared)' : ''}</option>`).join('');
    document.getElementById('tripHeading').textContent = currentTrip() ? currentTrip().name : 'Trip itinerary';
    document.getElementById('sharedToggle').checked = !!currentTrip()?.shared;
    document.getElementById('sharedBadge').classList.toggle('show', !!currentTrip()?.shared);
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
    await persistPlaces();
    renderTripSelect();
    renderPlaces();
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
    showToast(trip.shared ? 'Trip is now shared' : 'Trip is now private');
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

  /* ============ Export / Import ============ */
  function exportJson() {
    const trip = currentTrip();
    const data = { tripName: trip.name, exportedAt: new Date().toISOString(), places, packages };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trip.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Itinerary exported');
  }

  function importJson(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const importedPlaces = Array.isArray(parsed) ? parsed : parsed.places;
        const importedPackages = Array.isArray(parsed) ? [] : (Array.isArray(parsed.packages) ? parsed.packages : []);
        if (!Array.isArray(importedPlaces)) throw new Error('bad shape');
        if (!window.confirm(`Import ${importedPlaces.length} stop(s)? This will replace the current trip's stops.`)) return;
        undoSnapshot = JSON.stringify(places);
        undoPackagesSnapshot = JSON.stringify(packages);
        places = importedPlaces;
        packages = importedPackages;
        renderPlaces();
        await persistPlaces();
        populatePackageSelect();
        showUndoToast('Itinerary imported');
      } catch (e) {
        showToast('Could not read that file');
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  /* ============ Helpers ============ */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /* ============ Time display (auto AM/PM + range detection) ============ */
  // Normalizes a single clock time to "h:mm AM/PM". Accepts "9", "9:30",
  // "09:30", "9am", "9:30pm", "21:30", "9:30 AM", etc. Returns the
  // original trimmed string untouched if it doesn't look like a time
  // (e.g. "Morning", "TBD") so nothing gets mangled.
  function formatClockTime(raw) {
    const t = raw.trim();
    if (!t) return t;

    // Already has (or ends with) an am/pm marker, with or without a colon.
    let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = (m[2] || '00').padStart(2, '0');
      const isPM = m[3].toLowerCase().startsWith('p');
      if (h === 0) h = 12;
      if (h > 12) h = h % 12 || 12; // tolerate "13 pm"-style typos
      return `${h}:${min} ${isPM ? 'PM' : 'AM'}`;
    }

    // Bare 24-hour time, e.g. "13:05", "9:00", "23:45".
    m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = m[2];
      if (h >= 0 && h <= 23) {
        const isPM = h >= 12;
        let h12 = h % 12;
        if (h12 === 0) h12 = 12;
        return `${h12}:${min} ${isPM ? 'PM' : 'AM'}`;
      }
    }

    // Not a recognizable time — leave it exactly as entered.
    return t;
  }

  // Splits on common range separators ("–", "-", "to", "—") and formats
  // each side; falls back to formatting the whole string as one time
  // (or returning it unchanged) if it isn't a two-part range.
  function formatTimeDisplay(raw) {
    if (!raw) return '';
    const parts = raw.split(/\s*(?:–|—|-|\bto\b)\s*/i).filter(Boolean);
    if (parts.length === 2) {
      return `${formatClockTime(parts[0])} – ${formatClockTime(parts[1])}`;
    }
    return formatClockTime(raw);
  }

  function getVisiblePlaces() {
    let list = currentFilter === 'all' ? places : places.filter(p => p.category === currentFilter);
    const q = document.getElementById('searchInput').value.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
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

  function updateBudgetTotal() {
    const usedPackageIds = new Set(places.filter(p => p.packageId).map(p => p.packageId));
    const individualTotal = places.reduce((sum, p) => sum + (p.packageId ? 0 : (parseFloat(p.cost) || 0)), 0);
    const packageTotal = packages
      .filter(pkg => usedPackageIds.has(pkg.id))
      .reduce((sum, pkg) => sum + (parseFloat(pkg.cost) || 0), 0);
    const total = individualTotal + packageTotal;
    const packagedStopCount = places.filter(p => p.packageId).length;
    const note = packagedStopCount
      ? `<span class="packaged-count"> (${usedPackageIds.size} package${usedPackageIds.size !== 1 ? 's' : ''}, ${packagedStopCount} stop${packagedStopCount !== 1 ? 's' : ''})</span>`
      : '';
    document.getElementById('budgetTotal').innerHTML = `<span>Est. total</span>$${total.toFixed(2)}${note}`;
  }

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
    if (packages.length === 0) { bar.style.display = 'none'; list.innerHTML = ''; return; }
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

  /* ============ Image handling (plain URL, no base64) ============ */
  function handleImageUrlInput() {
    const url = document.getElementById('placeImage').value.trim();
    const preview = document.getElementById('imagePreview');
    if (!url) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src = url;
    preview.style.display = 'block';
  }

  /* ============ Form (add / edit) ============ */
  async function submitForm() {
    const name = document.getElementById('placeName').value.trim();
    const category = document.getElementById('placeCategory').value;
    const day = document.getElementById('placeDay').value.trim();
    const time = document.getElementById('placeTime').value.trim();
    const address = document.getElementById('placeAddress').value.trim();
    const image = document.getElementById('placeImage').value.trim();
    const cost = document.getElementById('placeCost').value;
    const travelNext = document.getElementById('placeTravelNext').value.trim();
    const desc = document.getElementById('placeDesc').value.trim();
    const packageSel = document.getElementById('placePackage').value;
    const packageId = (packageSel && packageSel !== '__new__') ? packageSel : null;

    if (!name) return alert('Name is required.');

    const dupe = places.find(p => p.name.trim().toLowerCase() === name.toLowerCase() && p.id !== editingId);
    if (dupe && !window.confirm(`"${name}" is already on this itinerary. Add it again anyway?`)) return;

    if (editingId) {
      const p = places.find(pl => pl.id === editingId);
      if (p) {
        p.name = name; p.category = category; p.day = day; p.time = time;
        p.address = address; p.desc = desc; p.image = image || null;
        p.cost = packageId ? null : (cost === '' ? null : parseFloat(cost));
        p.travelNext = travelNext;
        p.packageId = packageId;
      }
      showToast('Stop updated');
    } else {
      places.push({
        id: Date.now().toString(), name, category, day, time, address, desc,
        image: image || null, cost: packageId ? null : (cost === '' ? null : parseFloat(cost)), travelNext, packageId
      });
      showToast('Stop added');
    }

    resetForm();
    renderPlaces();
    await persistPlaces();
  }

  function resetForm() {
    document.getElementById('placeName').value = '';
    document.getElementById('placeCategory').value = 'sightseeing';
    document.getElementById('placeDay').value = '';
    document.getElementById('placeTime').value = '';
    document.getElementById('placeAddress').value = '';
    document.getElementById('placeCost').value = '';
    document.getElementById('placeTravelNext').value = '';
    document.getElementById('placeDesc').value = '';
    document.getElementById('placeImage').value = '';
    const preview = document.getElementById('imagePreview');
    preview.style.display = 'none';
    preview.removeAttribute('src');
    populatePackageSelect('');
    editingId = null;
    document.getElementById('formTitle').textContent = 'Add a stop';
    document.getElementById('editBadge').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('submitBtn').innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg> Add stop';
  }

  function startEdit(id) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    editingId = id;
    document.getElementById('placeName').value = p.name;
    document.getElementById('placeCategory').value = p.category;
    document.getElementById('placeDay').value = p.day || '';
    document.getElementById('placeTime').value = p.time || '';
    document.getElementById('placeAddress').value = p.address || '';
    document.getElementById('placeCost').value = p.cost != null ? p.cost : '';
    populatePackageSelect(p.packageId || '');
    document.getElementById('placeTravelNext').value = p.travelNext || '';
    document.getElementById('placeDesc').value = p.desc || '';
    document.getElementById('placeImage').value = p.image || '';
    const preview = document.getElementById('imagePreview');
    if (p.image) { preview.src = p.image; preview.style.display = 'block'; } else { preview.style.display = 'none'; preview.removeAttribute('src'); }

    document.getElementById('formTitle').textContent = 'Edit stop';
    document.getElementById('editBadge').style.display = 'inline-block';
    document.getElementById('cancelBtn').style.display = 'inline-block';
    document.getElementById('submitBtn').textContent = 'Save changes';
    document.getElementById('controlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() { resetForm(); }

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

  /* ============ Reorder ============ */
  async function moveStop(id, direction) {
    const visible = getVisiblePlaces();
    const idx = visible.findIndex(p => p.id === id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= visible.length) return;
    const moved = visible[idx];
    const neighborId = visible[newIdx].id;
    const gi = places.findIndex(p => p.id === id);
    const gj = places.findIndex(p => p.id === neighborId);
    undoSnapshot = JSON.stringify(places);
    [places[gi], places[gj]] = [places[gj], places[gi]];
    lastFocusId = id;
    renderPlaces();
    await persistPlaces();
    announce(`${moved.name} moved ${direction < 0 ? 'up' : 'down'}`);
  }

  function handleDragStart(e) {
    if (!this._dragFromHandle) { e.preventDefault(); return; }
    draggedId = this.dataset.id;
    dragStartSnapshot = JSON.stringify(places);
    dropHappened = false;
    // Some browsers (Firefox always, Chrome inconsistently — especially over
    // file://) need dataTransfer populated for the drag session to behave;
    // without this the drop can silently fail or visually snap back even
    // though dragover reports a valid target.
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', this.dataset.id); } catch (err) { /* some browsers restrict this on file:// — safe to ignore */ }
    }
    document.body.classList.add('dnd-active');
    setTimeout(() => this.classList.add('dragging'), 0);
  }

  function setDragOver(el) {
    if (dragOverEl && dragOverEl !== el) dragOverEl.classList.remove('drag-over');
    dragOverEl = el;
    if (el) el.classList.add('drag-over');
  }

  // Finds the drop target within a container by locating the *nearest*
  // card/item to the cursor (by center-point distance) and deciding
  // before/after relative to that one card. This is more robust than
  // scanning row-by-row: a sparse last row (fewer cards than columns) or a
  // cursor that's dropped past every card's bounding box still always
  // resolves to *some* real target — in particular, hovering below/right
  // of the last card reliably resolves to "after the last card" instead
  // of occasionally falling through unresolved.
  // Two orientations:
  // - 'grid' (default): nearest card by 2D distance; before/after decided
  //   by which side of that card's horizontal midpoint the cursor is on.
  // - 'list': nearest item by vertical distance only (used for the
  //   single-column Route view); before/after decided by the item's
  //   vertical midpoint.
  // Returns null only when the container has no other items to compare
  // against — callers treat that as "drop at the end of this container".
  function findDropTarget(containerEl, clientX, clientY, opts = {}) {
    const selector = opts.itemSelector || '.card';
    const orientation = opts.orientation || 'grid';
    const items = [...containerEl.querySelectorAll(selector)].filter(el => el.dataset.id !== draggedId);
    if (items.length === 0) return null;

    let nearestEl = null, nearestRect = null, nearestDist = Infinity;
    for (const el of items) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = orientation === 'list' ? 0 : clientX - cx;
      const dy = clientY - cy;
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) { nearestDist = dist; nearestEl = el; nearestRect = rect; }
    }

    if (orientation === 'list') {
      const mid = nearestRect.top + nearestRect.height / 2;
      return { targetId: nearestEl.dataset.id, after: clientY >= mid, el: nearestEl };
    }
    const midX = nearestRect.left + nearestRect.width / 2;
    return { targetId: nearestEl.dataset.id, after: clientX >= midX, el: nearestEl };
  }

  // If the dragged place's "day" doesn't match groupKey, updates it so the
  // stop now belongs to whichever day-group container it was dropped into.
  // No-op when groupKey is undefined (grid isn't grouped by day, or this is
  // the Route view, neither of which has a day-group concept for D&D).
  function applyGroupKey(place, groupKey) {
    if (groupKey === undefined || !place) return;
    const current = (place.day && place.day.trim()) ? place.day.trim() : UNSCHEDULED_KEY;
    if (current !== groupKey) place.day = groupKey === UNSCHEDULED_KEY ? '' : groupKey;
  }

  // Keeps the `places` array in sync with the on-screen order as the user
  // drags, snapping the dragged item next to a specific target card/item.
  // Returns false (and leaves the array untouched) if the dragged item or
  // target can't be found.
  function reorderPlacesArray(targetId, after, groupKey) {
    const gi = places.findIndex(p => p.id === draggedId);
    if (gi === -1) return false;
    const item = places.splice(gi, 1)[0];
    let newIdx = places.findIndex(p => p.id === targetId);
    if (newIdx === -1) { places.splice(gi, 0, item); return false; }
    if (after) newIdx += 1;
    places.splice(newIdx, 0, item);
    applyGroupKey(item, groupKey);
    return true;
  }

  // Used when a container has no other cards to snap next to (an empty day
  // group, or the only-other-card-is-the-dragged-one case) — places the
  // dragged item after the last existing member of that group, or at the
  // very end of the array if the group is otherwise empty.
  function insertAtGroupEnd(groupKey) {
    const gi = places.findIndex(p => p.id === draggedId);
    if (gi === -1) return false;
    const item = places.splice(gi, 1)[0];
    let lastIdx = -1;
    for (let i = 0; i < places.length; i++) {
      const pk = (places[i].day && places[i].day.trim()) ? places[i].day.trim() : UNSCHEDULED_KEY;
      if (pk === groupKey) lastIdx = i;
    }
    places.splice(lastIdx === -1 ? places.length : lastIdx + 1, 0, item);
    applyGroupKey(item, groupKey);
    return true;
  }

  // Moves a card's real DOM element to sit at the end of `container`,
  // just before its end-drop-zone if present. Used when dragging into an
  // empty container (or the only other occupant is the dragged card).
  function moveDraggedElToContainerEnd(container, draggedEl) {
    const endZone = container.querySelector('.end-drop-zone');
    if (endZone) container.insertBefore(draggedEl, endZone); else container.appendChild(draggedEl);
  }

  function handleContainerDragOver(e) {
    if (!draggedId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    // Search the whole board, not just `this` — the dragged card may
    // currently live inside a *different* day-group container than the
    // one the cursor is over now, which is exactly the cross-group-move
    // case we need to support.
    const draggedEl = viewContainer.querySelector(`.card[data-id="${draggedId}"]`);
    if (!draggedEl) return;

    const groupKey = this.dataset.groupKey; // undefined when grid isn't grouped by day
    const result = findDropTarget(this, e.clientX, e.clientY, { itemSelector: '.card', orientation: 'grid' });

    if (result) {
      setDragOver(result.el);
      if (result.el === draggedEl) return;
      const alreadyInPlace = result.after
        ? draggedEl.previousElementSibling === result.el
        : draggedEl.nextElementSibling === result.el;
      if (!alreadyInPlace) {
        // Move the real card element — NOT a re-render — so the browser's
        // native drag session (anchored to this DOM node) stays alive,
        // while the other cards visually push out of the way. `.after()`/
        // `.before()` transparently relocate it even across containers.
        if (result.after) result.el.after(draggedEl); else result.el.before(draggedEl);
      }
      reorderPlacesArray(result.targetId, result.after, groupKey);
    } else {
      // Nothing to snap next to in this container (it's empty, or the
      // dragged card is the only thing in it) — drop it at this
      // container's end instead, so every bit of empty space is a valid
      // target, not just the area right next to an existing card.
      const endZone = this.querySelector('.end-drop-zone');
      setDragOver(endZone || this);
      const alreadyAtEnd = draggedEl.parentElement === this &&
        (!endZone || draggedEl.nextElementSibling === endZone);
      if (!alreadyAtEnd) moveDraggedElToContainerEnd(this, draggedEl);
      if (groupKey !== undefined) insertAtGroupEnd(groupKey);
    }
  }

  async function handleContainerDrop(e) {
    e.preventDefault();
    if (!draggedId) { console.warn('[waypoint] drop fired with no draggedId set'); return; }
    try {
      setDragOver(null);
      dropHappened = true;

      const moved = places.find(p => p.id === draggedId);
      if (!moved) { console.warn('[waypoint] dragged place not found in places[]', draggedId); return; }

      // The array was already reordered live during dragover; just persist.
      undoSnapshot = dragStartSnapshot;
      renderPlaces();
      await persistPlaces();
      announce(`${moved.name} reordered`);
      showUndoToast('Order updated');
    } catch (err) {
      console.error('[waypoint] reorder failed:', err);
    }
  }

  // ---- Route view drag & drop (flat list, no day-group concept) ----
  function handleRouteDragStart(e) {
    draggedId = this.dataset.id;
    dragStartSnapshot = JSON.stringify(places);
    dropHappened = false;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', this.dataset.id); } catch (err) { /* ignore */ }
    }
    document.body.classList.add('dnd-active');
    setTimeout(() => this.classList.add('dragging'), 0);
  }

  function handleRouteContainerDragOver(e) {
    if (!draggedId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const draggedEl = this.querySelector(`.route-item[data-id="${draggedId}"]`);
    if (!draggedEl) return;

    const result = findDropTarget(this, e.clientX, e.clientY, { itemSelector: '.route-item', orientation: 'list' });
    if (!result) { setDragOver(null); return; }

    setDragOver(result.el);
    if (result.el === draggedEl) return;
    const alreadyInPlace = result.after
      ? draggedEl.previousElementSibling === result.el
      : draggedEl.nextElementSibling === result.el;
    if (!alreadyInPlace) {
      if (result.after) result.el.after(draggedEl); else result.el.before(draggedEl);
    }
    reorderPlacesArray(result.targetId, result.after);
  }

  async function handleRouteContainerDrop(e) {
    e.preventDefault();
    if (!draggedId) { console.warn('[waypoint] drop fired with no draggedId set'); return; }
    try {
      setDragOver(null);
      dropHappened = true;

      const moved = places.find(p => p.id === draggedId);
      if (!moved) { console.warn('[waypoint] dragged place not found in places[]', draggedId); return; }

      undoSnapshot = dragStartSnapshot;
      renderPlaces();
      await persistPlaces();
      announce(`${moved.name} reordered`);
      showUndoToast('Order updated');
    } catch (err) {
      console.error('[waypoint] route reorder failed:', err);
    }
  }

  function buildEndDropZone() {
    // Purely a visual affordance now — the container-level dragover/drop
    // listeners (which this element bubbles up into) already handle drops
    // anywhere below the last card, this just shows the user where.
    const zone = document.createElement('div');
    zone.className = 'end-drop-zone';
    zone.setAttribute('aria-hidden', 'true');
    zone.textContent = 'Drop here to move to the end';
    return zone;
  }

  function handleDragEnd() {
    this.classList.remove('dragging');
    if (!dropHappened && dragStartSnapshot) {
      // Drag was cancelled (e.g. dropped outside the list, or Esc) —
      // restore the pre-drag order rather than keeping the live shuffle.
      places = JSON.parse(dragStartSnapshot);
      renderPlaces();
    }
    draggedId = null;
    dragStartSnapshot = null;
    dropHappened = false;
    setDragOver(null);
    document.body.classList.remove('dnd-active');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleCardKeydown(e, id) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveStop(id, e.key === 'ArrowUp' ? -1 : 1);
    }
  }

  /* ============ Export list to clipboard ============ */
  function copyItinerary() {
    const visible = getVisiblePlaces();
    if (visible.length === 0) { showToast('Nothing to copy'); return; }
    const lines = visible.map((p, i) => {
      const parts = [`${i + 1}. ${p.name}`];
      if (p.day) parts.push(`[${p.day}]`);
      if (p.time) parts.push(`@ ${p.time}`);
      parts.push(`(${p.category})`);
      if (p.packageId) {
        const pkg = packages.find(pk => pk.id === p.packageId);
        parts.push(`- part of "${pkg ? pkg.name : 'package'}"${pkg ? ` ($${(parseFloat(pkg.cost) || 0).toFixed(2)} total)` : ''}`);
      } else if (p.cost) parts.push(`- $${parseFloat(p.cost).toFixed(2)}`);
      let line = parts.join(' ');
      if (p.address) line += `\n   ${p.address}`;
      if (p.desc) line += `\n   ${p.desc}`;
      if (p.travelNext) line += `\n   Next stop: ${p.travelNext}`;
      return line;
    });
    const text = `${currentTrip() ? currentTrip().name : 'Itinerary'}\n\n${lines.join('\n\n')}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('Itinerary copied')).catch(() => showToast('Could not copy'));
    } else {
      showToast('Clipboard not available');
    }
  }

  /* ============ Rendering ============ */
  function categoryDotColor(category) {
    return { dining: 'var(--tag-dining)', sightseeing: 'var(--tag-sightseeing)', outdoors: 'var(--tag-outdoors)' }[category];
  }

  function buildCardEl(place, globalIndex, visible) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = place.id;
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${place.name}, stop ${globalIndex + 1}. Press Alt plus arrow keys to reorder.`);

    card._dragFromHandle = false;
    card.addEventListener('mousedown', (e) => { card._dragFromHandle = !!e.target.closest('.drag-handle'); });
    card.addEventListener('touchstart', (e) => { card._dragFromHandle = !!e.target.closest('.drag-handle'); }, { passive: true });

    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    card.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));

    const idxInVisible = visible.findIndex(p => p.id === place.id);
    const isFirst = idxInVisible === 0;
    const isLast = idxInVisible === visible.length - 1;
    const isConfirming = confirmingDeleteId === place.id;

    const categoryBadge = `<span class="category-tag card-badge tag-${place.category}">${place.category}</span>`;
    const imageMarkup = (place.image
      ? `<img class="card-image" src="${place.image}" alt="${escapeHtml(place.name)}" draggable="false">`
      : `<div class="card-image-placeholder" draggable="false">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`) + categoryBadge;

    const mapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
    const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
    const costLineHtml = placePkg
      ? `<div class="card-meta-line packaged-line"><span class="included-pill">${escapeHtml(placePkg.name)}</span><span class="package-price">$${(parseFloat(placePkg.cost) || 0).toFixed(2)} <span class="price-note">total</span></span></div>`
      : (place.cost ? `<div class="card-meta-line cost">$${parseFloat(place.cost).toFixed(2)}</div>` : '');

    card.innerHTML = `
      ${imageMarkup}
      <div class="card-body">
        <div class="card-header">
          <div class="card-header-top">
            <div class="card-header-left">
              <div class="drag-handle" title="Drag to reorder" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="3" r="1.2" fill="currentColor"/><circle cx="11" cy="3" r="1.2" fill="currentColor"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="5" cy="13" r="1.2" fill="currentColor"/><circle cx="11" cy="13" r="1.2" fill="currentColor"/></svg>
              </div>
              <span class="stop-index">${globalIndex + 1}</span>${place.time ? `<span class="stop-time" title="${escapeHtml(place.time)}">${escapeHtml(formatTimeDisplay(place.time))}</span>` : ''}
            </div>
          </div>
          <h3 class="card-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h3>
        </div>
        <p class="card-desc"${place.desc ? ` title="${escapeHtml(place.desc)}"` : ''}>${escapeHtml(place.desc) || 'No notes added.'}</p>
        ${costLineHtml}
        ${mapsUrl ? `<a class="card-address" href="${mapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>
          ${escapeHtml(place.address)}
        </a>` : ''}
        ${place.travelNext ? `<div class="card-meta-line">→ ${escapeHtml(place.travelNext)} to next stop</div>` : ''}
        <div class="card-footer">
          <span class="reorder-hint">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="3" r="1.2" fill="currentColor"/><circle cx="11" cy="3" r="1.2" fill="currentColor"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="5" cy="13" r="1.2" fill="currentColor"/><circle cx="11" cy="13" r="1.2" fill="currentColor"/></svg>
            Drag to reorder
          </span>
          <div class="footer-actions">
            <button class="text-btn edit-btn" onclick="startEdit('${place.id}')">Edit</button>
            <button class="text-btn delete-btn ${isConfirming ? 'confirming' : ''}" onclick="requestDelete('${place.id}')">${isConfirming ? 'Confirm?' : 'Remove'}</button>
          </div>
        </div>
      </div>
    `;

    return card;
  }

  function renderEmptyState(container, reason) {
    const messages = {
      filter: ['No stops in this category', 'Try a different filter, or add a new stop above.'],
      search: ['No matches', 'Try a different search term.'],
      none: ['No stops yet', 'Add your first place above to start building the route.']
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

  function renderRouteView(container, visible) {
    const list = document.createElement('div');
    list.className = 'route-list';

    visible.forEach((place, i) => {
      const gi = places.findIndex(p => p.id === place.id);
      const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
      const costLineHtml = placePkg
        ? `<div class="route-cost packaged-line"><span class="included-pill">${escapeHtml(placePkg.name)}</span><span class="package-price">$${(parseFloat(placePkg.cost) || 0).toFixed(2)} <span class="price-note">total</span></span></div>`
        : (place.cost ? `<div class="route-cost">$${parseFloat(place.cost).toFixed(2)}</div>` : '');
      const item = document.createElement('div');
      item.className = 'route-item';
      item.dataset.id = place.id;
      item.draggable = true;
      item.tabIndex = 0;
      item.setAttribute('aria-label', `${place.name}, stop ${gi + 1}. Press Alt plus arrow keys to reorder.`);
      item.addEventListener('dragstart', handleRouteDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));
      item.innerHTML = `
        <div class="route-line-wrap">
          <div class="route-dot" style="background:${categoryDotColor(place.category)}"></div>
          ${i < visible.length - 1 ? `<div class="route-connector"></div><div class="route-connector-label">${place.travelNext ? escapeHtml(place.travelNext) : ''}</div>` : ''}
        </div>
        <div class="route-content">
          <div class="route-meta">
            <span class="stop-index">${gi + 1}</span>
            <span class="category-tag tag-${place.category}">${place.category}</span>
            ${place.day ? `<span class="stop-time">${escapeHtml(place.day)}</span>` : ''}
            ${place.time ? `<span class="stop-time" title="${escapeHtml(place.time)}">${escapeHtml(formatTimeDisplay(place.time))}</span>` : ''}
          </div>
          <h4 class="route-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h4>
          <p class="route-desc"${place.desc ? ` title="${escapeHtml(place.desc)}"` : ''}>${escapeHtml(place.desc) || (place.address ? escapeHtml(place.address) : '')}</p>
          ${costLineHtml}
        </div>
      `;
      list.appendChild(item);
    });

    list.appendChild(buildEndDropZone());
    list.addEventListener('dragover', handleRouteContainerDragOver);
    list.addEventListener('drop', handleRouteContainerDrop);
    container.appendChild(list);
  }

  function renderPlaces() {
    viewContainer.innerHTML = '';
    updateBudgetTotal();
    renderPackagesBar();

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

    if (visible.length === 0) {
      const q = document.getElementById('searchInput').value.trim();
      renderEmptyState(viewContainer, places.length === 0 ? 'none' : (q ? 'search' : 'filter'));
      return;
    }

    if (currentView === 'route') renderRouteView(viewContainer, visible);
    else renderGridView(viewContainer, visible);

    if (lastFocusId) {
      const el = viewContainer.querySelector(`[data-id="${lastFocusId}"]`);
      if (el) el.focus();
      lastFocusId = null;
    }
  }

  /* ============ Toolbar events ============ */
  document.getElementById('filterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll('#filterGroup .pill-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderPlaces();
  });

  document.getElementById('viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    currentView = btn.dataset.view;
    document.querySelectorAll('#viewToggle .pill-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderPlaces();
  });

  const styleSheet = document.createElement('style');
  styleSheet.textContent = '@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }';
  document.head.appendChild(styleSheet);

  /* ============ Init ============ */
  (async function init() {
    await loadTripsIndex();
    currentTripId = trips[0].id;
    renderTripSelect();
    await loadCurrentTripPlaces();
  })();

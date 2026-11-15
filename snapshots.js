/* ============ Snapshots: rolling local history + "Restore a previous version" ============ */
// Plain script: load BEFORE app.js (uses its globals only when called).
// Each snapshot is the small serialized trip (the same text persistPlaces() writes), stored
// under  snap:<tripId>:<timestamp>  in private storage, newest MAX_SNAPSHOTS kept.
// NOTE: snapshots share browser storage with the app, so they protect against mistakes and
// bad loads, not against clearing site data. Use Export JSON for an off-browser copy.
const MAX_SNAPSHOTS = 5;
const AUTO_SNAPSHOT_GAP_MS = 5 * 60 * 1000;
let lastSnapshotAt = 0;
let saveBlocked = false;   // true when saved data could not be read: saving is disabled so nothing is overwritten

function snapKey(tripId, t) { return `snap:${tripId}:${t}`; }

async function takeSnapshot(label, raw) {
  try {
    const trip = currentTrip();
    if (!trip || !raw) return;
    const t = Date.now();
    const rec = { t, label, tripId: trip.id, tripName: trip.name, raw };
    await pruneSnapshots(MAX_SNAPSHOTS - 1);   // make room first
    await window.storage.set(snapKey(trip.id, t), JSON.stringify(rec), false);
    lastSnapshotAt = t;
  } catch (e) {
    // storage full: free space so the real save can still succeed
    try { await pruneSnapshots(2); } catch (e2) {}
  }
}

async function listSnapshots() {
  let keys = [];
  try { keys = (await window.storage.list('snap:', false)).keys || []; } catch (e) { return []; }
  const out = [];
  for (const k of keys) {
    try { const r = JSON.parse((await window.storage.get(k, false)).value); out.push({ key: k, ...r }); } catch (e) {}
  }
  return out.sort((a, b) => b.t - a.t);
}

async function pruneSnapshots(keep = MAX_SNAPSHOTS) {
  const all = await listSnapshots();
  for (const s of all.slice(keep)) { try { await window.storage.delete(s.key, false); } catch (e) {} }
}

function snapshotSummary(s) {
  try {
    const parsed = JSON.parse(s.raw);
    const d = parsed.delta || {};
    const added = (d.places && d.places.added || []).length;
    const edited = (d.places && d.places.modified || []).length;
    return `${added} added, ${edited} edited stop(s)`;
  } catch (e) { return ''; }
}

async function openRestoreDialog() {
  const snaps = await listSnapshots();
  let dlg = document.getElementById('restoreDialog');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'restoreDialog'; document.body.appendChild(dlg); }
  const rows = snaps.length ? snaps.map(s => `
      <div class="restore-row">
        <div><strong>${escapeHtml(s.tripName || 'Trip')}</strong> · ${escapeHtml(s.label || 'Auto')}<br>
        <span class="restore-meta">${new Date(s.t).toLocaleString()} · ${escapeHtml(snapshotSummary(s))}</span></div>
        <button type="button" class="icon-text-btn" data-key="${escapeHtml(s.key)}">Restore</button>
      </div>`).join('')
    : '<p class="restore-meta">No saved versions yet. One is taken automatically as you edit, and before Reset, Clear all, Import or Delete trip.</p>';
  dlg.innerHTML = `<h3>Restore a previous version</h3>
    <p class="restore-meta">Restoring first saves your current state as a version, so you can always switch back.</p>
    <div class="restore-list">${rows}</div>
    <div class="restore-actions"><button type="button" class="icon-text-btn" id="restoreClose">Close</button></div>`;
  dlg.querySelector('#restoreClose').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-key]').forEach(b => b.onclick = async () => { await restoreSnapshot(b.dataset.key); dlg.close(); });
  if (!dlg.open) dlg.showModal();
}

async function restoreSnapshot(key) {
  try {
    const snap = JSON.parse((await window.storage.get(key, false)).value);
    const res = applyParsedTrip(JSON.parse(snap.raw));
    if (!window.confirm(`Restore "${snap.tripName}" to the version from ${new Date(snap.t).toLocaleString()}?`)) return;
    const cur = currentTrip();
    if (cur && !saveBlocked) await takeSnapshot('Before restore', serializeTrip(cur));
    let trip = trips.find(t => t.id === snap.tripId);
    if (!trip) { trip = { id: snap.tripId, name: snap.tripName || 'Restored trip', shared: false }; trips.push(trip); await persistTripsIndex(); }
    currentTripId = trip.id;
    saveBlocked = false;
    hideRecoveryBanner();
    places = res.places; packages = res.packages; myList = res.myList;
    renderTripSelect(); populatePackageSelect(); renderPlaces();
    await persistPlaces();
    showToast('Version restored');
  } catch (e) { showToast('Could not restore that version'); }
}

/* ---- banner shown when saved data could not be read ---- */
function showRecoveryBanner(msg) {
  let b = document.getElementById('recoveryBanner');
  if (!b) { b = document.createElement('div'); b.id = 'recoveryBanner'; b.setAttribute('role', 'alert'); document.body.prepend(b); }
  b.innerHTML = `${escapeHtml(msg)} <button type="button" onclick="openRestoreDialog()">Restore a version</button> <button type="button" onclick="location.reload()">Reload</button>`;
}
function hideRecoveryBanner() { const b = document.getElementById('recoveryBanner'); if (b) b.remove(); }

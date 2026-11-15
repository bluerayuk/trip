/* ============ Export / Import / Copy ============ */
// Ways to get an itinerary in and out of the app:
//   - exportJson():      download the current trip as a .json file
//   - importJson(evt):   replace the current trip's stops from a .json file
//                        (accepts this app's export format or a bare array of stops)
//   - exportCsv():       download every stop (or My attractions) with its category as a .csv
//   - copyItinerary():   copy the currently visible stops to the clipboard as text
//   - exportMyListJson(): download just the "My attractions" shortlist as a .json file
//   - copyMyList():       copy just the "My attractions" shortlist to the clipboard as text
//
// Plain (non-module) script sharing globals with app.js. These functions are only
// called from button clicks (see index.html), never at startup, so load order
// relative to app.js isn't critical; it is loaded before app.js for consistency.
//
//   - Used from app.js: currentTrip, places, packages, myListIds, undoSnapshot,
//     undoPackagesSnapshot, undoMyListSnapshot, getVisiblePlaces, renderPlaces,
//     persistPlaces, populatePackageSelect, showToast, showUndoToast,
//     categoryLabel, formatRating.
//   - Used from my-list.js: getMyListPlaces.
//   - Exposed to index.html: exportJson, importJson, copyItinerary,
//     exportMyListJson, copyMyList.

/* ---- Shared helpers ---- */
// Builds the human-readable "N. Name [Day] (Category) ★rating - price" text used
// by both copyItinerary() and copyMyList(), so the two stay in sync instead of
// drifting apart as separate copies of the same formatting logic.
function buildStopListText(placesList, label) {
  const lines = placesList.map((p, i) => {
    const parts = [`${i + 1}. ${p.name}`];
    if (p.day) parts.push(`[${p.day}]`);
    parts.push(`(${categoryLabel(p.category)})`);
    const formattedRating = (p.rating != null && p.rating !== '') ? formatRating(p.rating) : null;
    if (formattedRating !== null) parts.push(`★ ${formattedRating}`);
    if (p.packageId) {
      const pkg = packages.find(pk => pk.id === p.packageId);
      parts.push(`- part of "${pkg ? pkg.name : 'package'}"${pkg ? ` ($${(parseFloat(pkg.cost) || 0).toFixed(2)} total)` : ''}`);
    } else if (p.cost != null && p.cost !== '') parts.push(p.cost == 0 ? '- Free' : `- $${parseFloat(p.cost).toFixed(2)}`);
    let line = parts.join(' ');
    if (p.summary) line += `\n   ${p.summary}`;
    if (p.address) line += `\n   ${p.address}`;
    if (p.desc) line += `\n   ${p.desc}`;
    if (p.website) line += `\n   ${p.website}`;
    return line;
  });
  return `${label}\n\n${lines.join('\n\n')}`;
}

// Shared download-a-.json-blob helper used by both full-trip and My-attractions
// export, so the file-naming/blob/anchor dance only lives in one place.
function downloadJsonFile(data, filenameBase) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---- JSON export / import (full trip) ---- */
function exportJson() {
  const trip = currentTrip();
  const base = trip.id === 'trip-default' ? 'sample' : 'none';
  const data = { format: DELTA_FORMAT, tripName: trip.name, exportedAt: new Date().toISOString(),
                 delta: computeDelta(places, packages, myList, base) };
  downloadJsonFile(data, trip.name);
  showToast('Changes exported');
}

function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const result = parsed.delta ? applyDelta(parsed.delta) : applyParsedTrip(parsed);
      if (!window.confirm(`Import ${result.places.length} stop(s)? This will replace the current trip's stops.`)) return;
      await takeSnapshot('Before import', serializeTrip(currentTrip()));
      undoSnapshot = JSON.stringify(places);
      undoPackagesSnapshot = JSON.stringify(packages);
      undoMyListSnapshot = JSON.stringify(myList);
      places = result.places; packages = result.packages; myList = result.myList;
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

/* ---- CSV export: attractions + categories ---- */
// One row per stop. Exports the "My attractions" shortlist when that tab is
// showing, otherwise every stop in the trip (ignoring filters, so nothing is
// silently left out). Opens cleanly in Excel / Google Sheets / Numbers.
function csvCell(v) {
  const s = (v == null) ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  try {
    const onMyList = (typeof activeTab !== 'undefined' && activeTab === 'mylist' && typeof getMyListPlaces === 'function');
    const list = onMyList ? getMyListPlaces() : places;
    if (!list || list.length === 0) { showToast('Nothing to export'); return; }
    const trip = currentTrip();
    const header = ['Name', 'Category', 'Day', 'Address', 'Cost', 'Rating', 'Package', 'Website', 'Summary'];
    const rows = list.map(p => {
      const pkg = p.packageId ? packages.find(pk => pk.id === p.packageId) : null;
      return [
        p.name,
        categoryLabel(p.category),
        p.day || '',
        p.address || '',
        (p.cost != null && p.cost !== '') ? p.cost : '',
        (p.rating != null && p.rating !== '') ? p.rating : '',
        pkg ? pkg.name : '',
        p.website || '',
        p.summary || ''
      ];
    });
    const body = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    const base = `${trip ? trip.name : 'trip'}${onMyList ? '-my-attractions' : '-attractions'}`;
    const filename = `${base.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
    showToast(`Exporting ${list.length} attraction${list.length === 1 ? '' : 's'}...`);
    try {
      const blob = new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads UTF-8
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (dlErr) {
      // Downloads can be blocked (sandboxed preview, in-app browser): copy the CSV instead
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(body).then(
          () => showToast('Download blocked - CSV copied to clipboard instead'),
          () => showToast('Download blocked and copy failed'));
      } else {
        showToast('Download blocked in this browser');
      }
    }
  } catch (err) {
    console.error('exportCsv failed', err);
    showToast('CSV export failed: ' + (err && err.message ? err.message : err));
  }
}
window.exportCsv = exportCsv;

// Safety net: if the page's HTML doesn't have an Export CSV button yet, add one next to Export JSON.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('button').forEach(btn => {
    if (btn.textContent.trim() !== 'Export JSON') return;
    const next = btn.nextElementSibling;
    if (next && /exportCsv/.test(next.getAttribute('onclick') || '')) return;
    const copy = btn.cloneNode(true);
    copy.textContent = 'Export CSV';
    copy.setAttribute('onclick', btn.getAttribute('onclick').replace('exportJson()', 'exportCsv()'));
    btn.after(copy);
  });
});

/* ---- Copy to clipboard (full trip) ---- */
function copyItinerary() {
  if (activeTab === 'mylist') { copyMyList(); return; }
  const visible = getVisiblePlaces();
  if (visible.length === 0) { showToast('Nothing to copy'); return; }
  const text = buildStopListText(visible, currentTrip() ? currentTrip().name : 'Itinerary');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('Itinerary copied')).catch(() => showToast('Could not copy'));
  } else {
    showToast('Clipboard not available');
  }
}

/* ---- My attractions: export / copy ---- */
// Only the shortlisted stops (and every package in full, since a partially
// included package would silently misrepresent its shared price on re-import).
// myListIds is included and set to every exported place's id, so importing
// this file elsewhere puts these stops straight into My attractions instead
// of the main grid.
function exportMyListJson() {
  const trip = currentTrip();
  const myPlaces = getMyListPlaces();
  if (myPlaces.length === 0) { showToast('Your list is empty'); return; }
  const data = {
    tripName: `${trip ? trip.name : 'Trip'} - My attractions`,
    exportedAt: new Date().toISOString(),
    places: myPlaces,
    packages,
    myList: myList.filter(e => myPlaces.some(p => p.id === e.placeId))
  };
  downloadJsonFile(data, `${trip ? trip.name : 'my-list'}-my-attractions`);
  showToast('My attractions exported');
}

function copyMyList() {
  const myPlaces = getMyListPlaces();
  if (myPlaces.length === 0) { showToast('Your list is empty'); return; }
  const label = `${currentTrip() ? currentTrip().name + ' — ' : ''}My attractions`;
  const text = buildStopListText(myPlaces, label);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('My attractions copied')).catch(() => showToast('Could not copy'));
  } else {
    showToast('Clipboard not available');
  }
}

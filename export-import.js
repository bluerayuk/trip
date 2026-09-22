/* ============ Export / Import / Copy ============ */
// Ways to get an itinerary in and out of the app:
//   - exportJson():      download the current trip as a .json file
//   - importJson(evt):   replace the current trip's stops from a .json file
//                        (accepts this app's export format or a bare array of stops)
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
  // myListIds is included so "My attractions" membership survives a round
  // trip through export -> import (including into a different browser/device,
  // which has its own separate storage and therefore starts with none).
  const data = { tripName: trip.name, exportedAt: new Date().toISOString(), places, packages, myListIds };
  downloadJsonFile(data, trip.name);
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
      undoMyListSnapshot = JSON.stringify(myListIds);
      const importedIds = new Set(importedPlaces.map(p => p.id));
      // Restore "My attractions" membership from the file when it carries one
      // (a full-trip export, or one made with "Export JSON" from the My
      // attractions section). Otherwise start empty rather than keeping the
      // previous trip's myListIds, which would reference places that no
      // longer exist after this wholesale replacement.
      const importedMyListIds = (!Array.isArray(parsed) && Array.isArray(parsed.myListIds))
        ? parsed.myListIds.filter(id => importedIds.has(id))
        : [];
      places = importedPlaces;
      packages = importedPackages;
      myListIds = importedMyListIds;
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

/* ---- Copy to clipboard (full trip) ---- */
function copyItinerary() {
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
    myListIds: myPlaces.map(p => p.id)
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

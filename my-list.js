/* ============ My attractions (personal shortlist) ============ */
// Everything for the "My attractions" shortlist: which stops are in it, the
// add/remove toggle, and rendering the section at the top of the page.
//
// Plain (non-module) script. It shares globals with app.js, so:
//   - Load this file BEFORE app.js in index.html. app.js kicks off init() as soon
//     as it runs, and init() ends up calling renderMyList().
//   - The STATE stays in app.js: `myListIds` (declared there because it is saved
//     and reset together with `places` / `packages` per trip).
//   - Functions used from app.js: places, packages, computeTotal, budgetTotalHtml,
//     buildCardEl, renderPlaces, persistPlaces, announce.
//   - Functions exposed to app.js / inline onclick handlers: getMyListPlaces,
//     isInMyList, toggleMyList, renderMyList.

// myListIds just stores ids of entries already present in `places`, so
// "My attractions" is always a live view onto the same data — editing or
// deleting a stop anywhere updates it everywhere automatically.
function getMyListPlaces() {
  return myListIds.map(id => places.find(p => p.id === id)).filter(Boolean);
}

function isInMyList(id) { return myListIds.includes(id); }

// A package's price is shared across every stop it covers, so treating
// "My attractions" membership per-stop would let someone shortlist half a
// package while computeTotal (which counts a package in full the moment
// any one of its stops is present) still charges the whole price. To keep
// the shortlist and the price it implies consistent, a packaged stop is
// added/removed as a whole group together with its package siblings.
function getPackageGroupIds(place) {
  if (!place) return [];
  if (!place.packageId) return [place.id];
  return places.filter(p => p.packageId === place.packageId).map(p => p.id);
}

async function toggleMyList(id) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  const groupIds = getPackageGroupIds(place);
  const pkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
  const inList = myListIds.includes(id);

  // Let the card(s) shrink out of their current spot before the underlying
  // arrays change and renderPlaces() rebuilds the grid out from under them.
  await animateCardsOut(groupIds);

  if (inList) {
    myListIds = myListIds.filter(x => !groupIds.includes(x));
  } else {
    const toAdd = groupIds.filter(gid => !myListIds.includes(gid));
    myListIds = myListIds.concat(toAdd);
  }

  renderPlaces();
  animateCardsIn(groupIds);
  await persistPlaces();

  const verb = inList ? 'removed from' : 'added to';
  const msg = (pkg && groupIds.length > 1)
    ? `${place.name} and ${groupIds.length - 1} other stop${groupIds.length - 1 !== 1 ? 's' : ''} from "${pkg.name}" ${verb} My attractions`
    : `${place.name} ${verb} My attractions`;
  announce(msg);
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
  const myPlaces = getMyListPlaces();
  grid.innerHTML = '';
  if (myPlaces.length === 0) {
    grid.style.display = 'none';
    if (empty) empty.style.display = 'block';
    if (section) section.classList.add('is-empty');
    return;
  }
  grid.style.display = 'grid';
  if (empty) empty.style.display = 'none';
  if (section) section.classList.remove('is-empty');
  // Not draggable: reordering here would silently reorder the underlying
  // trip stop list too, which would be a confusing side effect of just
  // browsing a shortlist.
  myPlaces.forEach((place, i) => {
    grid.appendChild(buildCardEl(place, i, myPlaces, { draggable: false, context: 'mylist' }));
  });
}

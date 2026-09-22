/* ============ Reorder: drag & drop (+ keyboard move) ============ */
// Everything that changes the order of stops:
//   - Mouse/touch drag & drop in Grid view (incl. moving a stop between day
//     groups when "Group by day" is on) and in Route view.
//   - moveStop(): the keyboard equivalent (Alt + Arrow Up/Down), called from
//     handleCardKeydown in app.js.
//
// Plain (non-module) script sharing globals with app.js:
//   - Load this file BEFORE app.js in index.html (app.js renders on startup and
//     the renderers attach these handlers / call buildEndDropZone()).
//   - Drag-only STATE lives here, since nothing else reads it.
//   - Used from app.js: places, viewContainer, UNSCHEDULED_KEY, undoSnapshot,
//     lastFocusId, getVisiblePlaces, renderPlaces, persistPlaces, announce,
//     showUndoToast.
//   - Exposed to app.js: moveStop, buildEndDropZone, handleDragStart,
//     handleDragEnd, handleContainerDragOver, handleContainerDrop,
//     handleRouteContainerDragOver.

/* ---- Drag state ---- */
let draggedId = null;
let dragOverEl = null;
let dragStartSnapshot = null; // places order when the drag began, for cancel/undo
let dropHappened = false;     // did a drop actually complete this drag?

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

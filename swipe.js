/* ============ Swipe view (Tinder-style picker for curating My attractions) ============ */
// A full-screen deck of the stops that aren't in "My attractions" yet.
// Stops with several locations get ONE CARD PER LOCATION.
//   Swipe right / bookmark / → key  = add the stop to My attractions (all its locations then appear there)
//   Swipe left  / ✕ / ← key         = skip this location (hidden from the deck; remembered per trip in this browser)
//   Swipe up / ? / ↑ / M            = maybe (this location only)
//   Undo button / Backspace         = take back the last decision
//   Tap a card                      = open its full details (insider tips)
//
// Plain script, load AFTER my-list.js and locations.js. Uses globals: places, myList, packages,
// currentTripId, isInMyList, persistPlaces, renderPlaces, updateTabCount, escapeHtml, categoryLabel,
// categoryDotColor, CATEGORY_LABELS, openDetailModal, setTab, showToast, expandMapEntries, entryTitle, baseIdOf.

const SWIPE_NAME = 'Swipe';
const SWIPE_TITLE = 'Curate attractions';

/* ---- Sound effects (Web Audio, synthesised: no audio files to ship) ---- */
const SWIPE_SOUND_KEY = 'swipeSound';
let swipeSoundOn = true;
try { swipeSoundOn = localStorage.getItem(SWIPE_SOUND_KEY) !== 'off'; } catch (e) {}
let swipeAudio = null;

function swipeAudioCtx() {
  if (!swipeAudio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { swipeAudio = new AC(); } catch (e) { return null; }
  }
  if (swipeAudio.state === 'suspended') swipeAudio.resume().catch(() => {});
  return swipeAudio;
}

function swipeTone(ac, t, freq, dur, o = {}) {
  const { type = 'sine', gain = 0.18, to = null, attack = 0.008 } = o;
  const osc = ac.createOscillator(), g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t); osc.stop(t + dur + 0.03);
}

function swipeNoise(ac, t, dur, from, to, gain) {
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ac.destination);
  src.start(t);
}

const SWIPE_SOUNDS = {
  like(ac, t) {
    swipeTone(ac, t, 880, 0.16, { type: 'triangle', gain: 0.2 });
    swipeTone(ac, t + 0.07, 1318.5, 0.3, { type: 'triangle', gain: 0.2 });
    swipeTone(ac, t + 0.07, 2637, 0.2, { gain: 0.035 });
  },
  skip(ac, t) { swipeNoise(ac, t, 0.22, 2400, 500, 0.22); },
  maybe(ac, t) {
    swipeTone(ac, t, 520, 0.14, { gain: 0.16 });
    swipeTone(ac, t + 0.1, 700, 0.24, { gain: 0.16, to: 770 });
  },
  undo(ac, t) { swipeTone(ac, t, 760, 0.13, { type: 'triangle', gain: 0.14, to: 420 }); },
  tick(ac, t) { swipeTone(ac, t, 1900, 0.04, { gain: 0.05, attack: 0.002 }); },
  done(ac, t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => swipeTone(ac, t + i * 0.09, f, 0.32, { type: 'triangle', gain: 0.15 }));
  }
};

function swipePlay(name) {
  if (!swipeSoundOn) return;
  const ac = swipeAudioCtx();
  if (!ac) return;
  try { SWIPE_SOUNDS[name](ac, ac.currentTime + 0.005); } catch (e) {}
}

function swipeSoundSync() {
  const b = swipeEl && swipeEl.querySelector('.swipe-sound');
  if (!b) return;
  b.classList.toggle('is-off', !swipeSoundOn);
  b.setAttribute('aria-pressed', String(swipeSoundOn));
  const label = swipeSoundOn ? 'Mute sound effects' : 'Turn on sound effects';
  b.setAttribute('aria-label', label);
  b.title = label;
}

function swipeToggleSound() {
  swipeSoundOn = !swipeSoundOn;
  try { localStorage.setItem(SWIPE_SOUND_KEY, swipeSoundOn ? 'on' : 'off'); } catch (e) {}
  swipeSoundSync();
  swipePlay('tick');
}

// Skipped / maybe sets hold ENTRY ids: a stop's id for its main location, `${stopId}#${i}` for extra locations.
let swipeSkipped = new Set();
let swipeMaybe = new Set();
let swipeHistory = [];      // [{ id, action: 'like' | 'skip' | 'maybe', entry? }]
let swipeCat = 'all';
let swipeBusy = false;
let swipeTotal = 0;
let swipeChanged = false;
let swipeEl = null;

const SWIPE_THRESHOLD = 100;

/* ---- Skipped / maybe (per trip, per browser) ---- */
const swipeKey = () => 'swipeSkipped:' + currentTripId;
function swipeLoadSkipped() {
  try { swipeSkipped = new Set(JSON.parse(localStorage.getItem(swipeKey()) || '[]')); }
  catch (e) { swipeSkipped = new Set(); }
}
const swipeMaybeKey = () => 'swipeMaybe:' + currentTripId;
function swipeLoadMaybe() {
  try { swipeMaybe = new Set(JSON.parse(localStorage.getItem(swipeMaybeKey()) || '[]')); }
  catch (e) { swipeMaybe = new Set(); }
}
function swipeSaveMaybe() {
  try { localStorage.setItem(swipeMaybeKey(), JSON.stringify([...swipeMaybe])); } catch (e) {}
}
// Every location (card) of every stop that isn't on My attractions yet.
function swipeAllEntries() {
  return expandMapEntries(places.filter(p => !isInMyList(p.id)));
}
function swipeMaybeCount() {
  return swipeAllEntries().filter(e => swipeMaybe.has(e.id) && !swipeSkipped.has(e.id)).length;
}
function swipeSaveSkipped() {
  try { localStorage.setItem(swipeKey(), JSON.stringify([...swipeSkipped])); } catch (e) {}
}

/* ---- Nearest-first ordering ---- */
const SWIPE_SORT_KEY = 'swipeNearest';
let swipeNearest = true;
try { swipeNearest = localStorage.getItem(SWIPE_SORT_KEY) !== 'off'; } catch (e) {}
let swipeAnchor = null;   // { id, name, lat, lng } of the last location decided on

const swipeLoc = (p) => !!p && typeof p.lat === 'number' && typeof p.lng === 'number';
function swipeKm(a, b) {
  if (typeof tourLegKm === 'function') return tourLegKm(a, b);
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) * 1.3;
}
function swipeAnchorFrom(p) { return swipeLoc(p) ? { id: p.id, name: entryTitle(p), lat: p.lat, lng: p.lng } : null; }
function swipeInitAnchor() {
  swipeAnchor = null;
  for (let i = myList.length - 1; i >= 0; i--) {
    const p = places.find(x => x.id === myList[i].placeId);
    if (swipeLoc(p)) { swipeAnchor = swipeAnchorFrom(p); break; }
  }
}
function swipeOrder(list) {
  if (!swipeNearest) return list;
  const located = list.filter(swipeLoc);
  if (!located.length) return list;
  const rest = list.filter(p => !swipeLoc(p));
  const from = swipeAnchor || located[0];
  return located
    .map((p, i) => ({ p, i, km: swipeKm(from, p) }))
    .sort((a, b) => a.km - b.km || a.i - b.i)
    .map(x => x.p)
    .concat(rest);
}
function swipeNearHtml(p) {
  if (!swipeNearest || !swipeAnchor || !swipeLoc(p) || p.id === swipeAnchor.id) return '';
  const leg = typeof tourFmtLeg === 'function' ? tourFmtLeg(swipeAnchor, p) : swipeKm(swipeAnchor, p).toFixed(1) + ' km';
  return `<div class="swipe-near"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s6-5.6 6-10.5A6 6 0 0 0 6 10.5C6 15.4 12 21 12 21z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="10.5" r="2.2" fill="currentColor"/></svg>${escapeHtml(leg)} from ${escapeHtml(swipeAnchor.name)}</div>`;
}
function swipeSortSync() {
  const b = swipeEl && swipeEl.querySelector('.swipe-sort');
  if (!b) return;
  b.classList.toggle('is-off', !swipeNearest);
  b.setAttribute('aria-pressed', String(swipeNearest));
  const label = swipeNearest ? 'Nearest first: on (click for trip order)' : 'Nearest first: off (click to sort by distance)';
  b.setAttribute('aria-label', label);
  b.title = label;
}
function swipeToggleSort() {
  if (swipeBusy) return;
  swipeNearest = !swipeNearest;
  try { localStorage.setItem(SWIPE_SORT_KEY, swipeNearest ? 'on' : 'off'); } catch (e) {}
  swipeSortSync();
  swipePlay('tick');
  swipeRender();
}

// The deck: one entry (card) per location.
function swipeQueue() {
  const entries = swipeAllEntries();
  if (swipeCat === 'maybe') {
    return swipeOrder(entries.filter(e => swipeMaybe.has(e.id) && !swipeSkipped.has(e.id)));
  }
  return swipeOrder(entries.filter(e =>
    !swipeSkipped.has(e.id) && !swipeMaybe.has(e.id) &&
    (swipeCat === 'all' || e.category === swipeCat)));
}

function swipePrice(p) {
  const pkg = p.packageId ? packages.find(k => k.id === p.packageId) : null;
  const v = pkg ? (parseFloat(pkg.cost) || 0) : (p.cost != null && p.cost !== '' ? parseFloat(p.cost) : null);
  if (v == null || Number.isNaN(v)) return '';
  return v === 0 ? 'Free' : '$' + v.toFixed(2) + (pkg ? ' (package)' : '');
}

/* ---- Build the overlay once ---- */
function swipeBuild() {
  if (swipeEl) return;
  if (!document.getElementById('swipeMaybeStyle')) {
    const st = document.createElement('style');
    st.id = 'swipeMaybeStyle';
    st.textContent = '.swipe-maybe{color:#ffc857;width:3.2rem;height:3.2rem}'
      + '.swipe-maybe:hover:not(:disabled){background:#e0a526;color:#fff;border-color:#e0a526}'
      + '.swipe-stamp-maybe{left:50%;top:1.3rem;color:#ffc857;transform:translateX(-50%)}';
    document.head.appendChild(st);
  }
  swipeEl = document.createElement('div');
  swipeEl.className = 'swipe-overlay';
  swipeEl.setAttribute('role', 'dialog');
  swipeEl.setAttribute('aria-modal', 'true');
  swipeEl.setAttribute('aria-label', SWIPE_TITLE);
  swipeEl.innerHTML = `
    <div class="swipe-bg"></div>
    <div class="swipe-top">
      <button type="button" class="swipe-close" aria-label="Close ${SWIPE_NAME}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="swipe-title"><strong>${SWIPE_TITLE}</strong><span class="swipe-meta"><span class="swipe-count" aria-live="polite"></span><button type="button" class="swipe-sort" aria-pressed="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s6-5.6 6-10.5A6 6 0 0 0 6 10.5C6 15.4 12 21 12 21z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10.5" r="2.2" fill="currentColor"/><path class="swipe-slash" d="M4.5 4.5l15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button><button type="button" class="swipe-sound" aria-pressed="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path class="swipe-waves" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path class="swipe-slash" d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></span></div>
      <select class="swipe-cat" aria-label="Category"></select>
    </div>
    <div class="swipe-progress" aria-hidden="true"><span></span></div>
    <div class="swipe-stack"></div>
    <div class="swipe-actions">
      <button type="button" class="swipe-btn swipe-undo" aria-label="Undo" title="Undo (Z or Backspace)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button type="button" class="swipe-btn swipe-no" aria-label="Skip" title="Skip (←)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg></button>
      <button type="button" class="swipe-btn swipe-maybe" aria-label="Maybe" title="Maybe (\u2191 or M)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9.2 9a3 3 0 1 1 4.6 2.5c-1 .6-1.8 1.2-1.8 2.5M12 17.6v.1" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>
      <button type="button" class="swipe-btn swipe-yes" aria-label="Add to My attractions" title="Add (→)"><svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg></button>
    </div>
    <p class="swipe-hint"><span class="hint-touch">Swipe right to save &middot; left to skip &middot; up for maybe &middot; tap for details</span><span class="hint-pc">Drag the card, or press <b>&larr;</b> skip &middot; <b>&rarr;</b> save &middot; <b>&uarr;</b> maybe &middot; <b>Enter</b> details &middot; <b>Z</b> undo &middot; <b>Esc</b> close</span></p>`;
  document.body.appendChild(swipeEl);

  swipeEl.querySelector('.swipe-close').onclick = closeSwipe;
  swipeEl.querySelector('.swipe-no').onclick = () => swipeDecide('skip');
  swipeEl.querySelector('.swipe-maybe').onclick = () => swipeDecide('maybe');
  swipeEl.querySelector('.swipe-yes').onclick = () => swipeDecide('like');
  swipeEl.querySelector('.swipe-undo').onclick = swipeUndo;
  swipeEl.querySelector('.swipe-sound').onclick = swipeToggleSound;
  swipeEl.querySelector('.swipe-sort').onclick = swipeToggleSort;
  swipeSortSync();
  swipeEl.tabIndex = -1;
  swipeEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail > 0) b.blur(); });
  [['.swipe-undo', 'Z'], ['.swipe-no', '\u2190'], ['.swipe-maybe', '\u2191'], ['.swipe-yes', '\u2192']].forEach(([sel, key]) =>
    swipeEl.querySelector(sel).insertAdjacentHTML('beforeend', `<kbd aria-hidden="true">${key}</kbd>`));
  swipeSoundSync();
  swipeEl.querySelector('.swipe-cat').onchange = (e) => { swipeCat = e.target.value; swipeTotal = swipeQueue().length; swipeRender(); };

  const views = document.getElementById('viewToggle');
  if (views && !document.getElementById('viewSwipe')) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'viewSwipe'; b.className = 'pill-btn swipe-pill';
    b.textContent = SWIPE_NAME;
    b.title = SWIPE_TITLE;
    b.onclick = openSwipe;
    views.appendChild(b);
  }
}

function openSwipe() {
  swipeBuild();
  swipeLoadSkipped();
  swipeLoadMaybe();
  swipeHistory = [];
  swipeChanged = false;
  if (typeof repairKnownCoords === 'function' && repairKnownCoords()) persistPlaces();
  swipeInitAnchor();
  swipeTotal = swipeQueue().length;
  const sel = swipeEl.querySelector('.swipe-cat');
  sel.innerHTML = '<option value="all">All</option>' +
    '<option value="maybe">Maybe (' + swipeMaybeCount() + ')</option>' +
    Object.entries(CATEGORY_LABELS).map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join('');
  sel.value = swipeCat;
  swipeEl.classList.add('open');
  if (swipeSoundOn) swipeAudioCtx();
  swipeEl.focus({ preventScroll: true });
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', swipeKeydown);
  swipeRender();
}

function closeSwipe() {
  if (!swipeEl) return;
  swipeEl.classList.remove('open');
  document.body.classList.remove('modal-open');
  document.removeEventListener('keydown', swipeKeydown);
  if (swipeChanged) renderPlaces();
}

function swipeKeydown(e) {
  const modal = document.getElementById('detailModalOverlay');
  if (modal && modal.classList.contains('open')) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.repeat && e.key !== 'Escape') return;
  const onButton = !!(e.target.closest && e.target.closest('button'));
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Escape') closeSwipe();
  else if (k === 'ArrowRight') { e.preventDefault(); swipeDecide('like'); }
  else if (k === 'ArrowLeft') { e.preventDefault(); swipeDecide('skip'); }
  else if (k === 'ArrowUp' || k === 'm') { e.preventDefault(); if (swipeCat !== 'maybe') swipeDecide('maybe'); }
  else if (k === 'Backspace' || k === 'z' || k === 'u') { e.preventDefault(); swipeUndo(); }
  else if ((k === 'Enter' || k === ' ' || k === 'i') && !(onButton && k !== 'i')) {
    const p = swipeQueue()[0];
    if (p && p.desc && !swipeBusy) { e.preventDefault(); openDetailModal(baseIdOf(p.id)); }
  }
}

/* ---- Rendering ---- */
function swipeCardHtml(p) {
  const color = categoryDotColor(p.category) || 'var(--accent)';
  const price = swipePrice(p);
  const addr = typeof tidyAddress === 'function' ? tidyAddress(p.address) : String(p.address || '');
  const img = p.image
    ? `<img src="${escapeHtml(p.image)}" alt="" draggable="false" onerror="this.style.display='none'">`
    : '';
  const base = places.find(x => x.id === baseIdOf(p.id)) || p;
  const total = mapEntriesOf(base).length;
  const locNote = total > 1 && p.isBranch ? ` <span>&middot;</span> Location ${mapEntriesOf(base).findIndex(x => x.id === p.id) + 1} of ${total}` : (total > 1 ? ` <span>&middot;</span> Location 1 of ${total}` : '');
  return `
    <div class="swipe-img" style="--c:${color}">${img}</div>
    <div class="swipe-scrim"></div>
    <div class="swipe-stamp swipe-stamp-like">Save</div>
    <div class="swipe-stamp swipe-stamp-nope">Skip</div>
    <div class="swipe-stamp swipe-stamp-maybe">Maybe</div>
    <div class="swipe-info">
      <div class="swipe-eyebrow"><i style="background:${color}"></i>${escapeHtml(categoryLabel(p.category))}${price ? `<span>&middot;</span>${escapeHtml(price)}` : ''}${locNote}</div>
      <h3>${escapeHtml(entryTitle(p))}</h3>
      <p>${escapeHtml(p.summary || '')}</p>
      ${swipeNearHtml(p)}
      ${addr ? `<div class="swipe-addr">${escapeHtml(addr)}</div>` : ''}
      ${p.desc ? '<span class="swipe-more">View insider tips <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><kbd class="swipe-kbd-inline">Enter</kbd></span>' : ''}
    </div>`;
}

function swipeRender() {
  const q = swipeQueue();
  const stack = swipeEl.querySelector('.swipe-stack');
  const saved = myList.length;
  const catName = swipeCat === 'all' ? '' : ` \u00b7 ${swipeCat === 'maybe' ? 'Maybe' : categoryLabel(swipeCat)}`;
  const maybeN = swipeMaybeCount();
  swipeEl.querySelector('.swipe-count').textContent = `${q.length} left \u00b7 ${saved} saved${maybeN ? ` \u00b7 ${maybeN} maybe` : ''}${catName}`;
  if (swipeTotal < q.length) swipeTotal = q.length;
  swipeEl.querySelector('.swipe-progress span').style.width = (swipeTotal ? (1 - q.length / swipeTotal) * 100 : 100) + '%';
  swipeEl.querySelector('.swipe-bg').style.backgroundImage = q[0] && q[0].image ? `url("${q[0].image.replace(/"/g, '%22')}")` : 'none';
  swipeEl.querySelector('.swipe-undo').disabled = swipeHistory.length === 0;
  swipeEl.querySelector('.swipe-no').disabled = swipeEl.querySelector('.swipe-yes').disabled = q.length === 0;
  swipeEl.querySelector('.swipe-maybe').disabled = q.length === 0 || swipeCat === 'maybe';
  swipeEl.querySelector('.swipe-hint').style.visibility = q.length ? '' : 'hidden';

  if (!q.length) {
    const skipped = swipeSkipped.size;
    stack.innerHTML = `<div class="swipe-empty">
      <h3>You're all caught up</h3>
      <p>${saved} attraction${saved !== 1 ? 's' : ''} saved${skipped ? `, ${skipped} skipped` : ''}.</p>
      <button type="button" class="icon-text-btn tour-primary" data-go="list">View My attractions</button>
      ${maybeN && swipeCat !== 'maybe' ? `<button type="button" class="icon-text-btn" data-go="maybe">Review maybes (${maybeN})</button>` : ''}
      ${skipped ? '<button type="button" class="icon-text-btn" data-go="reset">Bring back skipped</button>' : ''}
    </div>`;
    stack.querySelector('[data-go="list"]').onclick = () => { closeSwipe(); setTab('mylist'); };
    const m = stack.querySelector('[data-go="maybe"]');
    if (m) m.onclick = () => { swipeCat = 'maybe'; swipeEl.querySelector('.swipe-cat').value = 'maybe'; swipeTotal = swipeQueue().length; swipeRender(); };
    const r = stack.querySelector('[data-go="reset"]');
    if (r) r.onclick = () => { swipeSkipped.clear(); swipeSaveSkipped(); swipeRender(); };
    return;
  }

  q.slice(3, 7).forEach(p => { if (p.image) { const im = new Image(); im.src = p.image; } });

  stack.innerHTML = '';
  q.slice(0, 3).reverse().forEach((p, i, arr) => {
    const depth = arr.length - 1 - i;
    const card = document.createElement('div');
    card.className = 'swipe-card' + (depth === 0 ? ' is-top' : '');
    card.dataset.id = p.id;
    card.style.transform = depth ? `scale(${1 - depth * 0.05}) translateY(${depth * 14}px)` : '';
    card.style.zIndex = String(10 - depth);
    card.innerHTML = swipeCardHtml(p);
    stack.appendChild(card);
    if (depth === 0) swipeAttachDrag(card, p);
  });
}

/* ---- Dragging ---- */
function swipeAttachDrag(card, place) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, moved = false, armed = false;
  const like = card.querySelector('.swipe-stamp-like');
  const nope = card.querySelector('.swipe-stamp-nope');
  const maybe = card.querySelector('.swipe-stamp-maybe');

  card.addEventListener('pointerdown', (e) => {
    if (swipeBusy || e.button > 0) return;
    dragging = true; moved = false; armed = false; startX = e.clientX; startY = e.clientY; dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const k = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
    const up = swipeCat !== 'maybe' && dy < 0 && Math.abs(dy) > Math.abs(dx);
    like.style.opacity = !up && dx > 0 ? k : 0;
    nope.style.opacity = !up && dx < 0 ? k : 0;
    maybe.style.opacity = up ? Math.min(1, Math.abs(dy) / SWIPE_THRESHOLD) : 0;
    const past = up ? Math.abs(dy) > SWIPE_THRESHOLD : Math.abs(dx) > SWIPE_THRESHOLD;
    if (past && !armed) { armed = true; swipePlay('tick'); } else if (!past) armed = false;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) {
      card.style.transition = '';
      if (place.desc) openDetailModal(baseIdOf(place.id));
      return;
    }
    if (swipeCat !== 'maybe' && dy < -SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) swipeDecide('maybe', dx, dy);
    else if (Math.abs(dx) > SWIPE_THRESHOLD) swipeDecide(dx > 0 ? 'like' : 'skip', dx, dy);
    else {
      card.style.transition = 'transform .2s ease';
      card.style.transform = '';
      like.style.opacity = nope.style.opacity = maybe.style.opacity = 0;
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

/* ---- Decisions ---- */
async function swipeDecide(action, fromX, fromY) {
  if (swipeBusy) return;
  const place = swipeQueue()[0];   // an entry: a stop's main location or one extra location
  if (!place) return;
  swipeBusy = true;
  swipePlay(action);

  const card = swipeEl.querySelector('.swipe-card.is-top');
  if (card) {
    const dir = action === 'like' ? 1 : -1;
    card.style.transition = 'transform .28s ease, opacity .28s ease';
    card.style.transform = action === 'maybe'
      ? `translate(${fromX || 0}px, ${-window.innerHeight}px)`
      : `translate(${dir * window.innerWidth}px, ${(fromY || 0) + 40}px) rotate(${dir * 28}deg)`;
    card.style.opacity = '0';
    await new Promise(r => setTimeout(r, 260));
  }

  const wasMaybe = swipeMaybe.has(place.id);
  if (action === 'maybe') {
    swipeMaybe.add(place.id);
    swipeSaveMaybe();
    swipeHistory.push({ id: place.id, action });
  } else if (action === 'like') {
    if (wasMaybe) { swipeMaybe.delete(place.id); swipeSaveMaybe(); }
    // My attractions is per stop, so saving any location saves the whole stop
    const entry = { id: 'ml-' + Date.now() + Math.random().toString(36).slice(2), placeId: baseIdOf(place.id), day: '', note: '' };
    myList.push(entry);
    swipeHistory.push({ id: place.id, action, entry, wasMaybe });
  } else {
    if (wasMaybe) { swipeMaybe.delete(place.id); swipeSaveMaybe(); }
    swipeSkipped.add(place.id);
    swipeSaveSkipped();
    swipeHistory.push({ id: place.id, action, wasMaybe });
  }
  swipeHistory[swipeHistory.length - 1].prevAnchor = swipeAnchor;
  if (swipeLoc(place)) swipeAnchor = swipeAnchorFrom(place);
  swipeChanged = true;
  swipeBusy = false;
  swipeRender();
  updateTabCount();
  persistPlaces();
  if (!swipeQueue().length) setTimeout(() => swipePlay('done'), 180);
}

function swipeUndo() {
  if (swipeBusy) return;
  const last = swipeHistory.pop();
  if (!last) return;
  swipePlay('undo');
  if (last.prevAnchor !== undefined) swipeAnchor = last.prevAnchor;
  if (last.action === 'maybe') { swipeMaybe.delete(last.id); swipeSaveMaybe(); }
  else {
    if (last.action === 'like') myList = myList.filter(e => e.id !== last.entry.id);
    else { swipeSkipped.delete(last.id); swipeSaveSkipped(); }
    if (last.wasMaybe) { swipeMaybe.add(last.id); swipeSaveMaybe(); }
  }
  swipeChanged = true;
  swipeRender();
  updateTabCount();
  persistPlaces();
}

// Build the overlay + entry button as soon as the DOM is there.
swipeBuild();

// S&P 900 Momentum — page logic. The model lives in model.js; this file loads
// data, renders, and runs the user-initiated refresh against FMP.
import {
  MODEL, DEFAULT_SETTINGS, decodePrices, encodePrices, buildModel, rankPool, scoreStock,
  excludeReason, activeFit, rankGroups, truncateHistory,
} from './model.js';

const FMP = 'https://financialmodelingprep.com/stable/';
const REF_SYMBOLS = ['AAPL', 'MSFT'];   // their daily history tells us which sessions a refresh must fill
const MAX_SESSIONS = 800;           // keep a little more than the 3-year regression window
const SPLIT_JUMP = Math.log(1.2);   // a new daily move beyond ±20% triggers a full re-download of that name (splits)
const RECONCILE_SESSIONS = 21;      // at least every 21 sessions, re-fetch every name's adjusted series (dividends)
const ADJ = 'historical-price-eod/dividend-adjusted';   // dividend- and split-adjusted closes (the stored series)
const SP400_API = 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_400_companies&prop=text&format=json&formatversion=2&origin=*';
const HORIZONS = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, '3Y': 756 };
const PAST = { '1w': 5, '1m': 21 };   // "as of" rankings: sessions back
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- persistence -------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const idb = {
  open() {
    return new Promise((res, rej) => {
      const q = indexedDB.open('momentum', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  /** Resolves with the request result; rejects when storage is unavailable or the write fails. */
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error || new Error('storage error'));
      tx.onabort = () => rej(tx.error || new Error('storage aborted'));
    });
  },
  get(k) { return this.run('readonly', s => s.get(k)).catch(() => undefined); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
  del(k) { return this.run('readwrite', s => s.delete(k)).catch(() => undefined); },
};

// ---- state -------------------------------------------------------------------
const state = {
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  hz: store.get('hz', '6M'),
  overlay: store.get('overlay', 'none'),      // chart overlay: 'none' | 'bench' | 'resid'
  scope: { index: 'all', group: null },
  view: store.get('view', 'stocks'),         // 'stocks' | 'groups'
  watch: new Set(store.get('watch', [])),     // watched tickers (this device)
  watchOnly: false,                            // list filter: watched names only (ranks stay those of the pool)
  query: '',
  universe: null, history: null, model: null,
  asOf: null,                 // { session, ts, refreshedAt, requests }
  ranking: { rows: [], excluded: [] },
  rowByTicker: new Map(),
  prevRank: null, prevPoolKey: '',
  cur: null, busy: false,
};
if (!(state.settings.window in MODEL.WINDOWS) && state.settings.window !== 'blend') state.settings.window = 'blend';
if (!['raw', 'z', 'pct', 'rank'].includes(state.settings.display)) state.settings.display = 'raw';
if (!(state.hz in HORIZONS)) state.hz = '6M';
if (!['none', 'bench', 'resid'].includes(state.overlay)) state.overlay = 'none';
if (!['stocks', 'groups'].includes(state.view)) state.view = 'stocks';
if (!['one', 'two'].includes(state.settings.factors)) state.settings.factors = 'one';
const getKey = () => store.get('fmpKey', '');

// ---- motion --------------------------------------------------------------------
// Motion is decoration: every animation lands on the same final DOM the static
// render produces, and none runs when the user asks for reduced motion.
const MOTION = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const inView = el => { const r = el.getBoundingClientRect(); return r.bottom > -r.height && r.top < innerHeight + r.height; };
/** Tween a number and write it through fmt on every frame (~250 ms). */
function tween(from, to, fmt, ms = 260) {
  if (!MOTION || from === to || !(from === from) || !(to === to)) { fmt(to); return; }
  const t0 = performance.now();
  const step = now => { const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3; fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
/** Sliding pill under the pressed button of every segmented control. */
function layoutPills(root = document) {
  root.querySelectorAll('.seg').forEach(seg => {
    let pill = seg.querySelector(':scope > .pill');
    if (!pill) { pill = document.createElement('span'); pill.className = 'pill'; seg.prepend(pill); }
    const on = seg.querySelector('button[aria-pressed="true"]');
    if (!seg.offsetWidth) { seg.classList.remove('ready'); return; }      // hidden: lay out when shown, without a slide
    if (!on) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    pill.style.transform = `translateX(${on.offsetLeft}px)`; pill.style.width = `${on.offsetWidth}px`;
    if (!seg.classList.contains('ready')) requestAnimationFrame(() => seg.classList.add('ready'));   // no slide on first layout
  });
}

// ---- formatting --------------------------------------------------------------
const sign = v => v < 0 ? '−' : '+';
const fmtPct = (v, d = 1) => sign(v) + (Math.abs(v) * 100).toFixed(d) + '%';
const fmtNum = (v, d = 2) => sign(v) + Math.abs(v).toFixed(d);
const fmtBeta = v => (v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(2);
const fmtScore = v => state.settings.vol ? fmtNum(v) : fmtPct(v);
const money = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v.toFixed(2);
const fmtDate = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts).replace(',', '');
};
const fmtRange = (a, b) => a.slice(0, 4) === b.slice(0, 4)
  ? `${fmtDate(a, { month: 'short', day: 'numeric' })} – ${fmtDate(b, { month: 'short', day: 'numeric', year: 'numeric' })}`
  : `${fmtDate(a, { month: 'short', year: 'numeric' })} – ${fmtDate(b, { month: 'short', year: 'numeric' })}`;
const nyDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
const nyHour = ts => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(ts * 1000)) % 24;
const nyTime = ts => new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const displayText = row => {
  const d = state.settings.display;
  return d === 'z' ? fmtNum(row.z) : d === 'pct' ? `${Math.floor(row.pct)}%` : d === 'rank' ? `#${Math.round(row.rank)}` : fmtScore(row.score);
};
const rawLabel = () => `${state.settings.vol ? 'Vol-adjusted' : 'Annualized'} ${state.settings.residual ? 'residual' : 'log'} return${state.settings.r2 ? ' × R²' : ''}`;
const displayLabel = () => ({ raw: rawLabel(), z: 'Z-score', pct: 'Percentile', rank: 'Rank' })[state.settings.display];
const windowLabel = () => ({ '6m': '6M', '12m': '12M', blend: '6M+12M' })[state.settings.window];
const intradayAt = a => !!(a && a.ts && nyDate(a.ts) === a.session && nyHour(a.ts) < 16);
const isIntraday = () => intradayAt(state.asOf);
const ord = n => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.min(n % 10, 4) % 4] || 'th'); };
const weekdaysBetween = (a, b) => { let n = 0; const d = new Date(a + 'T12:00:00Z'); const end = new Date(b + 'T12:00:00Z'); for (d.setUTCDate(d.getUTCDate() + 1); d < end; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w > 0 && w < 6) n++; } return n; };

// ---- data ----------------------------------------------------------------------
async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
const decodeBundle = b => ({ dates: b.dates, px: Object.fromEntries(Object.entries(b.px).map(([t, c]) => [t, decodePrices(c)])) });
const encodeBundle = h => ({ dates: h.dates, px: Object.fromEntries(Object.entries(h.px).map(([t, p]) => [t, encodePrices(p)])) });

async function loadData() {
  const [universe, seed] = await Promise.all([fetchJSON('data/universe.json'), fetchJSON('data/history.json')]);
  const [stored, meta] = await Promise.all([idb.get('history'), idb.get('meta')]);
  state.universe = universe;
  const storedLast = stored && stored.dates ? stored.dates[stored.dates.length - 1] : '', seedLast = seed.dates[seed.dates.length - 1];
  if (storedLast > seedLast || (storedLast === seedLast && !intradayAt(meta))) {
    state.history = decodeBundle(stored);
    state.asOf = meta || { session: storedLast, reconciled: storedLast };
  } else {
    if (stored) { idb.del('history'); idb.del('meta'); }
    state.history = decodeBundle(seed);
    state.asOf = { session: seedLast, reconciled: seedLast };   // the bundle is fully adjusted as of its build
  }
  rebuild();
}

function rebuild() {
  state.model = buildModel(state.universe, state.history);
  state.past = null; state.pastRanks = null;
  recompute();
  schedulePast();
}
// Rankings as they stood a week and a month ago are recomputed from the stored
// history (the model built on the history cut at T-5 and T-21), in idle time
// after the first paint, then re-ranked instantly on every settings change.
let pastTimer = null, pastGen = 0;
function schedulePast() {
  clearTimeout(pastTimer);
  const gen = ++pastGen, pending = Object.keys(PAST), past = {};
  const idle = fn => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 0));
  const run = () => {                                            // one model per idle slot
    if (gen !== pastGen) return;                                 // a newer schedule (refresh) superseded this one
    const k = pending.shift();
    past[k] = buildModel(state.universe, truncateHistory(state.history, PAST[k]));
    if (pending.length) { idle(run); return; }
    state.past = past;
    rankPast();
    renderList(); if (state.cur) renderDetail(state.cur, true);
  };
  pastTimer = setTimeout(() => idle(run), 250);
}
function rankPast() {
  if (!state.past) { state.pastRanks = null; return; }
  const p = pool(), out = {};
  for (const [k, m] of Object.entries(state.past)) {
    const rows = rankPool(m, p, state.settings).rows;
    out[k] = { stocks: new Map(rows.map(r => [r.t, r.rank])), groups: new Map(rankGroups(m, rows).map(g => [g.t, g.rank])), n: rows.length };
  }
  state.pastRanks = out;
}
/** "▲12 1w" style delta of a row's rank against the ranking k sessions ago. */
function pastDelta(t, rank, kind, key = '1w') {
  const pr = state.pastRanks && state.pastRanks[key] && state.pastRanks[key][kind].get(t);
  if (pr === undefined) return '';
  const d = pr - rank;
  return d ? `<span class="pd ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)} ${key}</span>` : `<span class="pd">· ${key}</span>`;
}

// ---- ranking -------------------------------------------------------------------
function pool() {
  const { index, group } = state.scope;
  return state.model.stocks.filter(s => (index === 'all' || s.i === index) && (!group || s.g === group)).map(s => s.t);
}
function recompute() {
  const scopeKey = `${state.scope.index}|${state.scope.group || ''}`;
  state.prevRank = scopeKey === state.prevPoolKey ? new Map(state.ranking.rows.map(r => [r.t, r.rank])) : null;
  state.prevRows = state.prevRank ? rowLookup() : null;
  state.prevGroupRank = state.prevRank && state.groups ? new Map(state.groups.map(g => [g.t, g.rank])) : null;
  state.prevPoolKey = scopeKey;
  state.ranking = rankPool(state.model, pool(), state.settings);
  state.rowByTicker = new Map(state.ranking.rows.map(r => [r.t, r]));
  state.groups = rankGroups(state.model, state.ranking.rows);
  state.groupSize = new Map(); for (const t of pool()) { const g = state.model.byTicker.get(t).g; if (g) state.groupSize.set(g, (state.groupSize.get(g) || 0) + 1); }
  state.groupByName = new Map(state.groups.map(g => [g.t, g]));
  rankPast();
  render(true);
}
const groupsMode = () => state.view === 'groups' && !state.scope.group;
/** The rows the list shows and the lookup for the previous render (for ticks). */
const listRows = () => groupsMode() ? state.groups : state.ranking.rows;
const rowLookup = () => groupsMode() ? state.groupByName : state.rowByTicker;

// ---- rendering -----------------------------------------------------------------
function render(animate = false) {
  renderStatus(); renderChips(); renderHist(animate); renderList(animate); renderScope(); renderFilter();
  layoutPills();
  if (state.cur) renderDetail(state.cur, true);
}

function renderStatus() {
  const a = state.asOf, el = $('status-text');
  const text = state.busy ? state.busyText
    : `${fmtDate(a.session, { month: 'short', day: 'numeric' })} ${isIntraday() ? 'live' : 'close'} · ${a.refreshedAt ? 'updated ' + ago(a.refreshedAt) : 'not refreshed'}`;
  if (el.textContent !== text) {
    if (MOTION && !state.busy && el.textContent) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    el.textContent = text;
  }
  $('btn-refresh').classList.toggle('busy', state.busy);
}

function renderChips() {
  const s = state.settings, chips = [[windowLabel(), true]];
  if (s.skip) chips.push(['Skip 21', true]);
  if (s.residual) chips.push(['Residual', true]);
  if (s.vol) chips.push(['Vol-adj', true]);
  if (s.r2) chips.push(['× R²', true]);
  if ((s.residual || s.r2) && s.factors === 'two') chips.push(['2-factor', true]);
  if (s.display !== 'raw') chips.push([displayLabel(), false]);
  $('chips').innerHTML = chips.map(([c, on]) => `<span class="chip${on ? ' on' : ''}">${esc(c)}</span>`).join('');
  $('dist-n').textContent = groupsMode() ? `${state.groups.length} groups` : `${state.ranking.rows.length} ranked`;
}

/** Histogram of the pool's raw scores; the marked value's bin is highlighted. */
function histogramSVG(values, { mark = null, width = 360, height = 56, bins = 48, labels = true } = {}) {
  const n = values.length;
  if (!n) return '';
  const s = values.slice().sort((a, b) => a - b);
  let lo = s[Math.round(0.01 * (n - 1))], hi = s[Math.round(0.99 * (n - 1))];
  if (!(hi > lo)) { lo -= 1e-6; hi += 1e-6; }
  // Bars cover the 1st..99th percentile; the few names outside are not drawn (the labels say so).
  const counts = new Array(bins).fill(0), bin = v => Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * bins)));
  for (const v of values) if (v >= lo && v <= hi) counts[bin(v)]++;
  const max = Math.max(...counts) || 1, bw = width / bins, top = labels ? height - 14 : height, gap = 1.2;
  let out = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
  if (lo < 0 && hi > 0) { const zx = (0 - lo) / (hi - lo) * width; out += `<line class="zero" x1="${zx.toFixed(1)}" x2="${zx.toFixed(1)}" y1="0" y2="${top}"/>`; }
  const markBin = mark === null ? -1 : bin(mark);
  counts.forEach((c, i) => {
    const h = Math.max(c ? 2 : i === markBin ? 3 : 0, c / max * top), x = i * bw, center = lo + (i + .5) * (hi - lo) / bins;
    out += `<rect class="${i === markBin ? 'mark' : center >= 0 ? 'pos' : 'neg'}" x="${(x + gap / 2).toFixed(1)}" y="${(top - h).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
  });
  if (labels) out += `<text x="0" y="${height - 2}">\u2264 ${esc(fmtScore(lo))}</text><text x="${width}" y="${height - 2}" text-anchor="end">\u2265 ${esc(fmtScore(hi))}</text>`;
  return out + '</svg>';
}
function renderHist(animate = false) {
  const box = $('hist');
  const before = animate && MOTION ? [...box.querySelectorAll('rect')].map(r => ({ y: +r.getAttribute('y'), h: +r.getAttribute('height') })) : [];
  box.innerHTML = histogramSVG(listRows().map(r => r.score), { width: box.clientWidth || 360, bins: groupsMode() ? 24 : 48 });
  const rects = [...box.querySelectorAll('rect')];
  if (before.length !== rects.length) return;
  rects.forEach((r, i) => {
    const y1 = +r.getAttribute('y'), h1 = +r.getAttribute('height'), b = before[i];
    if (b.y === y1 && b.h === h1) return;
    try { r.animate([{ y: `${b.y}px`, height: `${b.h}px` }, { y: `${y1}px`, height: `${h1}px` }], { duration: 380, easing: EASE }); } catch { /* geometry not animatable here */ }
  });
}

function renderScope() {
  document.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', b.dataset.scope === state.scope.index));
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === state.view));
  $('search').parentElement.hidden = state.view === 'groups';
  $('list').setAttribute('aria-label', groupsMode() ? 'Ranked peer groups' : 'Ranked stocks');
}
function renderFilter() {
  const g = state.scope.group;
  $('filter').hidden = !g;
  if (g) $('filter-text').innerHTML = `Peer group · <b>${esc(g)}</b>${state.view === 'groups' ? ' <span class="dim">· back to groups</span>' : ''}`;
}

function rowHTML(row) {
  const s = state.model.byTicker.get(row.t), raw = row.score, d = state.settings.display;
  const cls = d === 'raw' || d === 'z' ? (raw > 0 ? 'up' : raw < 0 ? 'dn' : 'flat') : '';
  const sub = d === 'pct' || d === 'rank' ? fmtScore(raw) : `${ord(Math.floor(row.pct))} pct`;
  let mv = '';
  if (state.prevRank && state.prevRank.has(row.t)) {
    const d = state.prevRank.get(row.t) - row.rank;
    if (d) mv = `<span class="mv ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }
  return `<li class="row" data-t="${esc(row.t)}" role="button" tabindex="0"><span class="rk">${row.rank}</span>` +
    `<span class="id"><span class="tk">${esc(row.t)}${state.watch.has(row.t) ? '<span class="star" aria-label="watched">★</span>' : ''}${mv}</span><span class="nm">${esc(s ? s.n : '')}</span></span>` +
    `<span class="val"><span class="sc ${cls}">${displayText(row)}</span><span class="sub">${esc(sub)}${pastDelta(row.t, row.rank, 'stocks')}</span></span></li>`;
}
/** A peer-group row: the group's equal-weight score, its sector, size and leading name. */
function groupHTML(g) {
  const d = state.settings.display, cls = d === 'raw' || d === 'z' ? (g.score > 0 ? 'up' : g.score < 0 ? 'dn' : 'flat') : '';
  const sub = d === 'pct' || d === 'rank' ? fmtScore(g.score) : `${ord(Math.floor(g.pct))} pct`;
  let mv = '';
  if (state.prevGroupRank && state.prevGroupRank.has(g.t)) { const dd = state.prevGroupRank.get(g.t) - g.rank; if (dd) mv = `<span class="mv ${dd > 0 ? 'up' : 'dn'}">${dd > 0 ? '▲' : '▼'}${Math.abs(dd)}</span>`; }
  return `<li class="row group" data-t="${esc(g.t)}" data-g="1" role="button" tabindex="0"><span class="rk">${g.rank}</span>` +
    `<span class="id"><span class="tk">${esc(g.t)}${mv}</span><span class="nm">${esc(g.top)} leads · ${g.n}${state.groupSize && state.groupSize.get(g.t) > g.n ? ` of ${state.groupSize.get(g.t)}` : ''} names · ${esc(g.sector)}</span></span>` +
    `<span class="val"><span class="sc ${cls}">${displayText(g)}</span><span class="sub">${esc(sub)}${pastDelta(g.t, g.rank, 'groups')}</span></span></li>`;
}
function renderList(animate = false) {
  const q = state.query.trim().toUpperCase(), list = $('list');
  // FLIP: remember where the visible rows are, re-render, then slide them from there.
  const before = new Map();
  if (animate && MOTION) for (const li of list.children) if (li.dataset.t && inView(li)) before.set(li.dataset.t, li.getBoundingClientRect().top);
  if (groupsMode()) {
    list.dataset.display = state.settings.display;
    list.innerHTML = state.groups.length ? state.groups.map(groupHTML).join('') : '<li class="empty">Nothing to rank with these settings.</li>';
    if (MOTION) animateRows(list, before, animate);
    $('foot').textContent = 'Each group is the equal-weight mean of its members\u2019 scores. Tap a group to see its names.';
    return;
  }
  let rows = state.ranking.rows, extra = '', exRows = [];
  if (state.watchOnly) rows = rows.filter(r => state.watch.has(r.t));
  if (q) {
    const match = t => t.startsWith(q) || (state.model.byTicker.get(t) || { n: '' }).n.toUpperCase().includes(q);
    rows = rows.filter(r => match(r.t));
    exRows = state.ranking.excluded.filter(x => match(x.t) && (!state.watchOnly || state.watch.has(x.t)));
    extra = exRows.map(x => {
      const s = state.model.byTicker.get(x.t);
      return `<li class="row" data-t="${esc(x.t)}" role="button" tabindex="0"><span class="rk">—</span><span class="id"><span class="tk">${esc(x.t)}</span><span class="nm">${esc(s.n)}</span></span>` +
        `<span class="val"><span class="sc flat">—</span><span class="sub">${esc(x.reason)}</span></span></li>`;
    }).join('');
  }
  list.dataset.display = state.settings.display;
  state.navOrder = rows.concat(exRows).map(r => r.t);        // the order next / previous follow in the detail (unranked matches last)
  list.innerHTML = rows.length || extra ? rows.map(rowHTML).join('') + extra
    : `<li class="empty">${state.watchOnly && !state.watch.size ? 'No watched names yet. Star a stock from its page.' : q ? 'No matches.' : 'Nothing to rank with these settings.'}</li>`;
  $('watch-filter').setAttribute('aria-pressed', state.watchOnly);
  if (MOTION) animateRows(list, before, animate);
  const ex = state.ranking.excluded.length, noHist = state.universe.stocks.length - state.model.stocks.length;
  const bits = [];
  if (ex) bits.push(`${ex} not ranked (insufficient history${state.settings.residual || state.settings.r2 ? ' or benchmark' : ''})`);
  if (noHist) bits.push(`${noHist} without price data — refresh to fetch`);
  $('foot').textContent = bits.join(' · ');
}

/** Slide visible rows from their previous positions, tick their numbers, flash refreshed prices. */
function animateRows(list, before, animate) {
  let i = 0;
  for (const li of list.children) {
    const t = li.dataset.t;
    if (!t) continue;
    const box = li.getBoundingClientRect();
    if (box.bottom < 0) continue;
    if (box.top > innerHeight || i > 40) break;
    i++;
    if (state.firstPaint) { li.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: Math.min(i, 14) * 22, easing: EASE, fill: 'backwards' }); continue; }
    if (animate) {
      const top = before.get(t);
      if (top !== undefined) {
        const dy = top - li.getBoundingClientRect().top;
        if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: EASE });
      } else if (before.size) li.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
      const prev = state.prevRows && state.prevRows.get(t), row = rowLookup().get(t), sc = li.querySelector('.sc');
      if (prev && row && sc && !(state.settings.display === 'rank' && prev.rank === row.rank)) {
        const key = { raw: 'score', z: 'z', pct: 'pct', rank: 'rank' }[state.settings.display];
        tween(prev[key], row[key], v => { sc.textContent = displayText({ ...row, [key]: key === 'rank' ? Math.round(v) : v }); });
      }
    }
    const f = state.flash && state.flash.get(t);
    if (f) li.animate([{ backgroundColor: f > 0 ? 'var(--up-dim)' : 'var(--dn-dim)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  }
  state.firstPaint = false; state.flash = null;
}

// ---- detail page -----------------------------------------------------------------
function openDetail(t, push = true) {
  if (!state.model.byTicker.has(t)) return;
  if (openSheetId) closeSheet();
  if (!state.cur) state.detailFocus = document.activeElement;
  state.cur = t;
  renderDetail(t);
  renderDetailNav();
  $('detail').classList.add('on'); $('detail').setAttribute('aria-hidden', 'false');
  $('app').inert = true;
  document.body.classList.add('locked');
  if (push && location.hash !== '#' + t) history.pushState({ t }, '', '#' + t);
  else if (!push && !(history.state && history.state.t)) history.replaceState({ t, root: true }, '', '#' + t);   // deep link: no entry of ours to go back to
  $('d-body').scrollTop = 0;
  $('d-back').focus({ preventScroll: true });
}
/** Next / previous ticker in the list's current order (search and watch filters included). */
function navTo(dir) {
  const order = state.navOrder || [], i = order.indexOf(state.cur), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  const t = order[j];
  state.cur = t;
  renderDetail(t); renderDetailNav();
  history.replaceState({ ...(history.state || {}), t }, '', '#' + t);
  $('d-body').scrollTop = 0;
  if (MOTION) $('d-body').animate([{ opacity: 0, transform: `translateX(${dir * 24}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
}
function renderDetailNav() {
  const order = state.navOrder || [], i = order.indexOf(state.cur);
  $('d-prev').disabled = i <= 0; $('d-next').disabled = i < 0 || i >= order.length - 1;
  $('d-pos').textContent = i >= 0 ? `${i + 1} of ${order.length}` : '';
  const on = state.watch.has(state.cur);
  $('d-star').setAttribute('aria-pressed', on); $('d-star').setAttribute('aria-label', on ? 'Remove from watchlist' : 'Add to watchlist');
  $('d-star').querySelector('use').setAttribute('href', on ? '#i-star-on' : '#i-star');
}
function toggleWatch(t) {
  if (state.watch.has(t)) state.watch.delete(t); else state.watch.add(t);
  store.set('watch', [...state.watch]);
  if (state.cur === t) { renderDetailNav(); if (MOTION) $('d-star').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE }); }
  renderList();
}
function closeDetail(pop = true) {
  if (!state.cur) return;
  state.cur = null;
  $('detail').classList.remove('on'); $('detail').setAttribute('aria-hidden', 'true');
  $('app').inert = false;
  document.body.classList.remove('locked');
  if (pop && history.state && history.state.t && !history.state.root) history.back();
  else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (state.detailFocus && state.detailFocus.focus) state.detailFocus.focus({ preventScroll: true });
  state.detailFocus = null;
}

function renderDetail(t, keepScroll = false) {
  const s = state.model.byTicker.get(t), p = state.history.px[t], T = state.model.T, fit = state.model.fits.get(t), act = activeFit(state.model, t, state.settings);
  const row = state.rowByTicker.get(t), last = p[T - 1], prev = p[T - 2];
  const chg = last > 0 && prev > 0 ? last - prev : null;
  const inPool = pool().includes(t);
  const { parts } = scoreStock(state.model, t, state.settings);
  const scrollTop = $('d-body').scrollTop;
  $('d-ticker').textContent = t;
  const priceBlock = last > 0
    ? `<p class="d-price num">$${money(last)}</p>` +
      `<p class="d-chg num ${chg > 0 ? 'up' : chg < 0 ? 'dn' : 'flat'}">${chg === null ? '' : `${sign(chg)}$${money(Math.abs(chg))} (${fmtPct(chg / prev, 2)})`} <span class="when">${esc(fmtDate(state.asOf.session))} ${isIntraday() ? 'live' : 'close'}</span></p>`
    : `<p class="d-price">—</p><p class="d-chg flat">No price for the latest session</p>`;

  const momCard = row ? `
    <div class="big"><div><b class="${row.score > 0 ? 'up' : row.score < 0 ? 'dn' : ''}">${displayText(row)}</b><span class="big-label">${esc(displayLabel())}</span></div><span>#${row.rank} of ${state.ranking.rows.length}<br>${ord(Math.floor(row.pct))} percentile</span></div>
    <div class="histo mini">${histogramSVG(state.ranking.rows.map(r => r.score), { mark: row.score, width: Math.max(200, $('d-body').clientWidth - 64), height: 40, labels: false })}</div>
    ${state.settings.display !== 'raw' ? `<div class="kv"><span>${esc(rawLabel())}</span><b>${fmtScore(row.score)}</b></div>` : ''}
    <div class="kv"><span>Rank history<span class="hint">same settings, as ranked then</span></span><b class="ph">${state.pastRanks ? Object.entries(PAST).map(([k, back]) => { const pr = state.pastRanks[k].stocks.get(t); if (pr === undefined) return `<span><i>${k} ago</i> —</span>`; const d = pr - row.rank;
      return `<span><i>${k} ago</i> #${pr} <em class="${d > 0 ? 'up' : d < 0 ? 'dn' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '·'}${d ? Math.abs(d) : ''}</em></span>`; }).join('') : '<span class="hint">computing…</span>'}</b></div>
    <div class="kv"><span>Z-score</span><b>${fmtNum(row.z)}</b></div>
    ${Object.entries(parts).map(([w, m]) => `<div class="kv"><span>${w.toUpperCase()} stock return<span class="hint">${m.n} sessions${state.settings.skip ? ' · skip 21' : ''}</span></span>` +
      `<b>${fmtPct(m.stock)}${state.settings.residual ? `<span class="hint">benchmark ${fmtPct(m.bench)}</span>${m.mkt === m.mkt ? `<span class="hint">market ${fmtPct(m.mkt)}</span>` : ''}<span class="hint">residual ${fmtPct(m.signal)}</span>` : ''}` +
      `<span class="hint">vol ${(m.sd * Math.sqrt(MODEL.YEAR) * 100).toFixed(1)}% ann.</span></b></div>`).join('')}
    <div class="chipline">${[[windowLabel(), 1], ['Skip 21', state.settings.skip], ['Residual', state.settings.residual], ['2-factor', (state.settings.residual || state.settings.r2) && state.settings.factors === 'two'], ['Vol-adj', state.settings.vol], ['× R²', state.settings.r2]]
      .filter(([, on]) => on).map(([c]) => `<span class="chip on">${esc(c)}</span>`).join('')}</div>`
    : `<p class="note">${inPool ? `Not ranked: ${esc(excludeReason(state.model, t, state.settings))}.` : 'Outside the current universe filter.'}</p>`;

  const lvl = { peer: 'Peer group', sector: 'Sector', universe: 'S&P 900' }, twoF = act && act.factors === 2;
  const regCard = `
    ${fit.level ? `<div class="bench"><span class="bench-lv">${lvl[fit.level]} benchmark${fit.level !== 'peer' ? ' · fallback' : ''}${twoF ? ' + market' : ''}</span><b>${esc(fit.name)}${twoF ? ' <span class="plus">+ S&amp;P 900</span>' : ''}</b><span class="hint">Equal-weight, leave-one-out · ${fit.peers} other names${twoF ? ' · two factors fitted jointly' : ''}</span>${fit.level !== 'peer' ? `<span class="hint">Peer group ${esc(fit.tried[0].name)} not used: ${esc(fit.tried[0].reason.replace('peers', 'other names'))}</span>` : ''}</div>
    ${twoF ? `<div class="kv"><span>Beta · ${esc(fit.name)}</span><b>${fmtBeta(act.beta[0])}</b></div><div class="kv"><span>Beta · S&amp;P 900</span><b>${fmtBeta(act.beta[1])}</b></div>`
           : `<div class="kv"><span>Beta</span><b>${fmtBeta(act.beta)}</b></div>`}
    <div class="kv"><span>Alpha (annualized)</span><b>${fmtPct(act.alpha * MODEL.YEAR)}</b></div>
    <div class="kv"><span>R²</span><b>${act.r2.toFixed(2)}</b></div>
    <div class="kv"><span>Idiosyncratic volatility<span class="hint">residual sd, annualized</span></span><b>${(act.resid * Math.sqrt(MODEL.YEAR) * 100).toFixed(1)}%</b></div>
    <div class="kv"><span>Observations</span><b>${act.n}<span class="hint">daily, last ${MODEL.BETA_WINDOW} sessions</span></b></div>
    <div class="scatter" id="scatter"></div>
    <p class="note">Each dot is one session: the stock's daily log return against its benchmark's; the line is the one-factor fit.</p>`
    : `<p class="note">No viable benchmark: this name has too little overlapping history for a ${MODEL.BETA_WINDOW}-session regression (min ${MODEL.MIN_OBS} sessions).</p>`}
    <ul class="tried">${fit.tried.map(x => `<li class="${x.level === fit.level ? 'used' : ''}"><span class="lv">${x.level}</span><span class="nm">${esc(x.name || '')}</span><span class="why">${x.ok ? `β ${fmtBeta(x.beta)} · R² ${x.r2.toFixed(2)}${x.level === fit.level ? ' · used' : ''}` : esc(x.reason)}</span></li>`).join('')}</ul>
    <p class="note">The peer group is used when it has at least ${MODEL.MIN_PEERS} other names and ${MODEL.MIN_OBS} overlapping sessions; otherwise the sector, otherwise the whole S&P 900.</p>`;

  $('d-body').innerHTML = `
    <p class="d-name">${esc(s.n)}</p>${priceBlock}
    <div class="chart-head"><span class="hzc num" id="hzc"></span><span class="hzl" id="hzl"></span></div>
    <div class="chart-wrap" id="chart"></div>
    <div class="chart-ctl">
      <div class="seg" role="group" aria-label="Chart window">${Object.keys(HORIZONS).map(h => `<button type="button" data-hz="${h}" aria-pressed="${h === state.hz}">${h}</button>`).join('')}</div>
      <div class="seg overlay" role="group" aria-label="Overlay">${[['none', 'Price'], ['bench', 'Benchmark'], ['resid', 'Residual']].map(([k, l]) => `<button type="button" data-overlay="${k}" aria-pressed="${k === state.overlay}" ${k !== 'none' && !fit.bench ? 'disabled title="No benchmark for this name"' : ''}>${l}</button>`).join('')}</div>
    </div>
    <p class="chart-note">Adjusted for dividends and splits; the latest value is the last traded price.${state.overlay === 'bench' ? ' Dashed: the benchmark applied to the same starting price.' : state.overlay === 'resid' ? ` Dotted: the stock net of ${act && act.factors === 2 ? 'β₁ × benchmark + β₂ × S&amp;P 900' : 'β × benchmark'} (what residual momentum measures).` : ''}</p>
    <section class="card"><h3>Momentum</h3>${momCard}</section>
    <section class="card"><h3>Regression · 3 years</h3>${regCard}</section>
    <section class="card"><h3>Company</h3>
      <div class="kv"><span>Index</span><b>S&amp;P ${esc(s.i)}</b></div>
      <div class="kv"><span>Sector</span><b>${esc(s.s)}</b></div>
      <button class="linkrow" id="peers-link" type="button"><span>Peer group</span><b>${esc(s.g || '—')}<svg><use href="#i-chev"/></svg></b></button>
    </section>`;
  drawChart(t);
  if (fit.level) drawScatter(t);
  layoutPills($('detail'));
  document.querySelectorAll('[data-hz]').forEach(b => b.onclick = () => { state.hz = b.dataset.hz; store.set('hz', state.hz); renderDetail(t, true); });
  document.querySelectorAll('[data-overlay]').forEach(b => b.onclick = () => { state.overlay = b.dataset.overlay; store.set('overlay', state.overlay); renderDetail(t, true); });
  $('peers-link').onclick = () => { if (!s.g) return; state.scope.group = s.g; state.query = ''; $('search').value = ''; state.prevPoolKey = ''; closeDetail(); recompute(); window.scrollTo({ top: 0 }); };
  if (keepScroll) $('d-body').scrollTop = scrollTop;
}

function drawChart(t) {
  const box = $('chart'), W = box.clientWidth || 360, H = window.innerWidth >= 720 ? 280 : 230, padT = 24, padB = 20, padL = 6, padR = 6;
  const p = state.history.px[t], dates = state.history.dates, T = state.model.T, fit = activeFit(state.model, t, state.settings);
  const n = Math.min(HORIZONS[state.hz], T - 1), from = T - 1 - n;
  const ys = p.slice(from), xs = dates.slice(from);
  const first = ys.find(v => v > 0), lastIdx = ys.map(v => v > 0).lastIndexOf(true), last = ys[lastIdx];
  $('hzl').textContent = fmtRange(xs[0], xs[xs.length - 1]);
  if (!(first > 0) || !(last > 0)) { box.innerHTML = '<p class="note">No prices in this window.</p>'; $('hzc').textContent = ''; return; }
  // Overlay path from the stock's first price: the benchmark's cumulative return, or the
  // stock's cumulative residual (its return net of beta x benchmark, the residual-momentum series).
  let bench = null;
  if (state.overlay !== 'none' && fit.bench) {
    const two = fit.factors === 2, b1 = two ? fit.beta[0] : fit.beta, b2 = two ? fit.beta[1] : 0, r = state.model.ret.get(t);
    bench = new Array(ys.length).fill(null); let acc = Math.log(first), ok = true;
    for (let j = 0; j < ys.length; j++) {
      if (j === 0) { bench[j] = ys[0] > 0 ? first : null; continue; }
      const k = from + j, b = fit.bench[k], m = two ? fit.mkt[k] : 0;
      const step = state.overlay === 'bench' ? b : r[k] - b1 * b - b2 * m;
      if (step !== step || (two && m !== m)) { ok = false; bench[j] = null; continue; }
      if (!ok) { bench[j] = null; continue; }
      acc += step; bench[j] = Math.exp(acc);
    }
  }
  const vals = ys.filter(v => v > 0).concat(bench ? bench.filter(v => v > 0) : []);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  let lo = minV, hi = maxV; if (hi === lo) { hi += .5; lo -= .5; }
  const pad = (hi - lo) * .08; lo = Math.max(0, lo - pad); hi += pad;
  const X = i => padL + i / (ys.length - 1) * (W - padL - padR), Y = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
  const path = arr => { let d = '', pen = false; arr.forEach((v, i) => { if (!(v > 0)) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; }); return d; };
  const up = last >= first, col = up ? 'var(--up)' : 'var(--dn)', d = path(ys);
  const firstI = ys.findIndex(v => v > 0);
  const area = d ? d + `L${X(lastIdx).toFixed(1)} ${Y(lo).toFixed(1)}L${X(firstI).toFixed(1)} ${Y(lo).toFixed(1)}Z` : '';
  const ry = Y(first);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" id="csvg">
<path class="ar" d="${area}" fill="${col}"/>
<line class="ref" x1="0" x2="${W}" y1="${ry.toFixed(1)}" y2="${ry.toFixed(1)}"/>
<text x="${W - padR}" y="${(Y(maxV) - 6).toFixed(1)}" text-anchor="end">$${money(maxV)}</text><text x="${W - padR}" y="${(Y(minV) + 14).toFixed(1)}" text-anchor="end">$${money(minV)}</text>
${bench ? `<path class="${state.overlay === 'resid' ? 'rl' : 'bl'}" d="${path(bench)}"/>` : ''}
<path class="ln" d="${d}" stroke="${col}"/>
<g id="hover" style="display:none"><line class="hair" y1="${padT}" y2="${H - padB}"/><circle class="dot" r="4.5" fill="${col}"/></g></svg><div class="tip" id="tip" hidden></div>`;
  const chg = last - first;
  const hzcText = `${sign(chg)}$${money(Math.abs(chg))} (${fmtPct(chg / first, 2)})`;
  $('hzc').textContent = hzcText;
  $('hzc').style.color = col;
  const svg = $('csvg'), hov = $('hover'), tip = $('tip'), line = svg.querySelector('.ln'), areaEl = svg.querySelector('.ar');
  // Draw the line on when the ticker or the window changes (not on every re-render).
  const drawKey = `${t}|${state.hz}`;
  if (MOTION && drawKey !== state.drawKey && line.getTotalLength) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = `${len}`; line.style.strokeDashoffset = `${len}`;
    line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => { line.style.strokeDasharray = ''; line.style.strokeDashoffset = ''; };
    areaEl.animate([{ opacity: 0 }, { opacity: .14 }], { duration: 520, easing: 'ease-out' });
  }
  state.drawKey = drawKey;
  // Scrubbing: the headline price and window change follow the finger, and snap back on release.
  const priceEl = $('d-body').querySelector('.d-price'), priceText = `$${money(p[T - 1] > 0 ? p[T - 1] : last)}`;
  if (priceEl) priceEl.textContent = priceText;
  let lastI = -1;
  const move = e => {
    const r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width * W;
    let i = Math.round((fx - padL) / (W - padL - padR) * (ys.length - 1)); i = Math.max(0, Math.min(ys.length - 1, i));
    let j = i; while (j >= 0 && !(ys[j] > 0)) j--; if (j < 0) return; i = j;
    const x = X(i), y = Y(ys[i]);
    hov.style.display = ''; hov.querySelector('line').setAttribute('x1', x); hov.querySelector('line').setAttribute('x2', x);
    const c = hov.querySelector('circle'); c.setAttribute('cx', x); c.setAttribute('cy', y);
    tip.hidden = false;
    tip.innerHTML = `${esc(fmtDate(xs[i], { month: 'short', day: 'numeric', year: 'numeric' }))} <b>$${money(ys[i])}</b>${bench && bench[i] > 0 ? ` · ${state.overlay === 'resid' ? 'residual' : 'bench'} $${money(bench[i])}` : ''}`;
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = Math.max(half, Math.min(W - half, x)) + 'px';
    if (priceEl) { priceEl.textContent = `$${money(ys[i])}`; const c = ys[i] - first; $('hzc').textContent = `${sign(c)}$${money(Math.abs(c))} (${fmtPct(c / first, 2)})`; $('hzc').style.color = c >= 0 ? 'var(--up)' : 'var(--dn)'; }
    if (i !== lastI && e.pointerType === 'touch' && navigator.vibrate) navigator.vibrate(3);
    lastI = i;
  };
  const hide = () => { hov.style.display = 'none'; tip.hidden = true; lastI = -1;
    if (priceEl) { priceEl.textContent = priceText; $('hzc').textContent = hzcText; $('hzc').style.color = col; } };
  svg.onpointermove = move; svg.onpointerdown = move;
  svg.onpointerleave = e => { if (e.pointerType !== 'touch') hide(); };   // a touch readout stays until the next tap elsewhere
  $('d-body').onpointerdown = e => { if (!box.contains(e.target)) hide(); };
}

/** Daily stock returns against the benchmark over the regression window, with the one-factor line. */
function drawScatter(t) {
  const box = $('scatter'), fit = state.model.fits.get(t), r = state.model.ret.get(t), T = state.model.T;
  if (!box || !fit.bench) return;
  const W = Math.min(box.clientWidth || 360, 360), H = Math.round(W * 0.8), padX = 18, padT = 20, padB = 34, from = Math.max(1, T - MODEL.BETA_WINDOW);
  const pts = [];
  for (let k = from; k <= T - 1; k++) { const x = fit.bench[k], y = r[k]; if (x === x && y === y) pts.push([x, y]); }
  if (pts.length < 3) { box.innerHTML = ''; return; }
  const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.round(p * (s.length - 1))]; };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const lim = Math.max(Math.abs(q(xs, .005)), Math.abs(q(xs, .995)), Math.abs(q(ys, .005)), Math.abs(q(ys, .995))) * 1.05 || 0.01;
  const X = v => padX + (v + lim) / (2 * lim) * (W - 2 * padX), Y = v => H - padB - (v + lim) / (2 * lim) * (H - padT - padB);
  // Sessions beyond the 0.5%..99.5% box are drawn hollow at the edge so they are not read as data.
  const dots = pts.map(([x, y]) => { const out = Math.abs(x) > lim || Math.abs(y) > lim;
    return `<circle class="${out ? 'edge' : ''}" cx="${X(Math.max(-lim, Math.min(lim, x))).toFixed(1)}" cy="${Y(Math.max(-lim, Math.min(lim, y))).toFixed(1)}" r="1.6"/>`; }).join('');
  // The fitted line is clipped to the box, not clamped, so its slope stays beta.
  const f = x => fit.alpha + fit.beta * x;
  let xa = -lim, xb = lim;
  if (Math.abs(fit.beta) > 1e-12) { const e1 = (-lim - fit.alpha) / fit.beta, e2 = (lim - fit.alpha) / fit.beta; xa = Math.max(-lim, Math.min(e1, e2)); xb = Math.min(lim, Math.max(e1, e2)); }
  const pct = v => (v * 100).toFixed(0) + '%';
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
<line class="ax" x1="${padX}" x2="${W - padX}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/><line class="ax" y1="${padT}" y2="${H - padB}" x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}"/>
<g class="pts">${dots}</g>
<line class="fit" x1="${X(xa).toFixed(1)}" y1="${Y(f(xa)).toFixed(1)}" x2="${X(xb).toFixed(1)}" y2="${Y(f(xb)).toFixed(1)}"/>
<text x="${(X(0) + 4).toFixed(1)}" y="13">stock ±${pct(lim)}</text><text x="${W - padX}" y="${H - 6}" text-anchor="end">benchmark ±${pct(lim)}</text>
<text x="${padX}" y="${H - 6}">${state.settings.factors === 'two' ? 'one-factor ' : ''}β ${fmtBeta(fit.beta)} · R² ${fit.r2.toFixed(2)} · ${pts.length} sessions</text></svg>`;
}

// ---- sheets -----------------------------------------------------------------------
let openSheetId = null;
// The settings sheet is a compact, non-modal panel: the list stays visible and
// scrollable above it so the re-ranking can be watched while toggling. The data
// sheet is modal.
function openSheet(id) {
  closeSheet();
  openSheetId = id;
  const peek = id === 'sheet-settings';
  state.sheetFocus = document.activeElement;
  $(id).hidden = false; $(id).style.transform = ''; $(id).querySelector('.sheet-body').scrollTop = 0;
  requestAnimationFrame(() => $(id).classList.add('on'));
  if (peek) {
    document.documentElement.style.setProperty('--sheet-h', `${$(id).offsetHeight}px`);
    $('app').classList.add('peek');
  } else {
    $('backdrop').hidden = false;
    document.body.classList.add('locked');
    $('app').inert = true; $('detail').inert = true;
  }
  if (peek) renderSettings(); else renderDataSheet();
  layoutPills($(id));
  $(id).querySelector('[data-close]').focus({ preventScroll: true });
}
function closeSheet() {
  if (!openSheetId) return;
  const el = $(openSheetId); openSheetId = null;
  el.classList.remove('on'); el.hidden = true; el.style.transform = ''; $('backdrop').hidden = true;
  $('app').classList.remove('peek');
  $('detail').inert = false; $('app').inert = !!state.cur;
  if (!state.cur) document.body.classList.remove('locked');
  const inside = el.contains(document.activeElement) || document.activeElement === document.body;
  if (inside && state.sheetFocus && state.sheetFocus.focus) state.sheetFocus.focus({ preventScroll: true });
  state.sheetFocus = null;
}
/** Drag the handle or header down to dismiss (phones; the desktop dialog is centred). */
function dragToDismiss(sheet) {
  let y0 = null, dy = 0, vy = 0, lastY = 0, lastT = 0;
  const backdrop = $('backdrop');
  sheet.addEventListener('pointerdown', e => {
    if (window.innerWidth >= 720 || e.target.closest('button') || !e.target.closest('.grab, .sheet-top')) return;
    y0 = lastY = e.clientY; lastT = e.timeStamp; dy = vy = 0; sheet.style.transition = 'none'; backdrop.style.transition = 'none'; sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener('pointermove', e => {
    if (y0 === null) return;
    const raw = e.clientY - y0; dy = raw < 0 ? raw / 4 : raw;                 // rubber-band upwards
    const dt = e.timeStamp - lastT; if (dt > 0) vy = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = e.timeStamp;
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = `${Math.max(0, 1 - Math.max(0, dy) / sheet.offsetHeight)}`;
  });
  const end = () => {
    if (y0 === null) return; y0 = null; sheet.style.transition = ''; backdrop.style.transition = ''; backdrop.style.opacity = '';
    if (dy > 80 || vy > 0.6) closeSheet(); else sheet.style.transform = '';
  };
  sheet.addEventListener('pointerup', end); sheet.addEventListener('pointercancel', end);
}
/** Appearance: 'auto' follows the device; 'light' / 'dark' pin it. Applied before first paint by a
 *  one-line script in index.html; this keeps the buttons, the browser chrome colour and the pill in step. */
function applyTheme() {
  const t = store.get('theme', 'auto');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#sheet-settings [data-theme]').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === t));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000';
  layoutPills($('sheet-settings'));
}
function renderSettings() {
  const s = state.settings;
  document.querySelectorAll('[data-window]').forEach(b => b.setAttribute('aria-pressed', b.dataset.window === s.window));
  document.querySelectorAll('#sheet-settings [data-display]').forEach(b => b.setAttribute('aria-pressed', b.dataset.display === s.display));
  document.querySelectorAll('[data-factors]').forEach(b => b.setAttribute('aria-pressed', b.dataset.factors === s.factors));
  document.querySelectorAll('[data-flag]').forEach(i => { i.checked = !!s[i.dataset.flag]; });
  layoutPills($('sheet-settings'));
}
function setSettings(patch) {
  Object.assign(state.settings, patch);
  store.set('settings', state.settings);
  renderSettings();
  recompute();
}

function renderDataSheet() {
  const key = getKey();
  if (!state.model) {
    $('data-facts').innerHTML = ''; $('do-refresh').disabled = true; $('do-refresh').textContent = 'Refresh prices';
    setNote('refresh-note', 'The data bundle failed to load. Reload the page to try again.', 'err');
    $('key').placeholder = 'FMP API key'; setNote('key-note', key ? 'Key saved in this browser.' : '');
    return;
  }
  const a = state.asOf, T = state.model.T;
  $('data-facts').innerHTML = [
    ['Prices through', `${fmtDate(a.session, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} ${isIntraday() ? 'live ' + nyTime(a.ts) : 'close'}`],
    ['History', `${T} sessions · ${state.model.stocks.length} of ${state.universe.stocks.length} stocks`],
    ['Adjusted through', `${fmtDate(a.reconciled || a.session, { month: 'short', day: 'numeric' })}${a.pending && a.pending.length ? ` · ${a.pending.length} pending` : ''}`],
    ['Last refresh', a.refreshedAt ? `${ago(a.refreshedAt)} · ${a.requests} requests` : 'never (bundled data)'],
    ['FMP key', key ? `saved · ${key.slice(0, 4)}…` : 'none'],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('do-refresh').disabled = !key || state.busy || !state.model;
  $('do-members').disabled = !key;
  if (!$('member-note').textContent) setNote('member-note', 'Compares today\u2019s S&P 500 and 400 lists with the bundled universe and reports differences. Changes nothing.');
  $('do-refresh').textContent = state.busy ? 'Refreshing…' : 'Refresh prices';
  if (!state.busy) setNote('refresh-note', key
    ? `Quotes for all ${state.universe.stocks.length} stocks (${Math.ceil(state.universe.stocks.length / 100)} requests), 2 calendar requests when a session is added, and history only for missing sessions or names. Every ${RECONCILE_SESSIONS} sessions it re-fetches each name's adjusted series to pick up dividends and splits (about ${state.universe.stocks.length} requests); next in ${Math.max(0, RECONCILE_SESSIONS - T + Math.max(0, state.history.dates.indexOf(a.reconciled || '') + 1))} sessions.`
    : 'Add your Financial Modeling Prep key below to refresh prices. Nothing is fetched automatically.');
  $('key').value = '';
  $('key').placeholder = key ? 'Replace saved key' : 'FMP API key';
  setNote('key-note', key ? 'Stored only in this browser and sent only to financialmodelingprep.com.' : 'The key never leaves this browser except in requests to FMP.');
}
function setNote(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `note ${cls}`.trim(); }

// ---- toast --------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, cls = '') {
  const el = $('toast'); el.textContent = msg; el.className = `toast ${cls}`.trim(); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// ---- FMP refresh (manual only) --------------------------------------------------------
class FmpError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
const FATAL = new Set(['key', 'plan', 'rate']);
/**
 * One FMP request. `run` is the refresh in progress: its AbortController stops
 * in-flight requests once anything fatal happens, and its `wait` callback
 * surfaces a 429 back-off instead of pausing silently.
 */
async function fmp(path, params, key, run) {
  const u = new URL(FMP + path);
  for (const k in params) u.searchParams.set(k, params[k]);
  u.searchParams.set('apikey', key);
  for (let attempt = 0; ; attempt++) {
    if (run.aborted) throw new FmpError('aborted', 'Refresh cancelled');
    let r;
    run.n++;
    try { r = await fetch(u, { signal: run.ctl.signal }); }
    catch (e) { throw new FmpError(e.name === 'AbortError' ? 'aborted' : 'network', e.name === 'AbortError' ? 'Refresh cancelled' : 'Network error: could not reach FMP'); }
    if (r.status === 401 || r.status === 403) throw new FmpError('key', 'FMP rejected the API key');
    if (r.status === 402) throw new FmpError('plan', 'Endpoint not included in this FMP plan');
    if (r.status === 429) {
      if (attempt >= 3) throw new FmpError('rate', 'Rate limited by FMP: try again in a minute');
      const delay = Math.min(30000, 5000 * 2 ** attempt);
      if (run.wait) run.wait(delay, attempt + 1);
      await sleep(delay); continue;
    }
    if (!r.ok) throw new FmpError('http', `FMP error ${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body)) throw new FmpError('http', 'Unexpected reply from FMP');
    return body;
  }
}
/** Run fn over items with bounded concurrency; a fatal error aborts the whole run. */
async function mapLimit(items, limit, run, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !run.aborted) {
      const j = i++;
      try { await fn(items[j], j); }
      catch (e) { if (FATAL.has(e.kind) || e.kind === 'aborted') { run.abort(); throw e; } run.failed.push(items[j].t); }
    }
  });
  await Promise.all(workers);
}
function progress(text, frac = null) {
  if (!state.busy && text) return;                          // a worker outliving a failed run must not overwrite the error
  state.busyText = text; renderStatus();
  const bar = $('refresh-progress');
  bar.hidden = !state.busy;
  bar.firstElementChild.style.width = frac === null ? '0' : `${Math.round(frac * 100)}%`;
  if (openSheetId === 'sheet-data' && text) setNote('refresh-note', text);
}

async function refresh() {
  if (state.busy || !state.model) return;
  const key = getKey();
  if (!key) { openSheet('sheet-data'); setNote('refresh-note', 'Add your FMP key below, then press Refresh prices.', 'err'); return; }
  state.busy = true; refreshDone(null); renderStatus(); if (openSheetId === 'sheet-data') renderDataSheet();
  const hist = state.history, T = hist.dates.length, L = hist.dates[T - 1], intradayL = isIntraday();
  const run = { n: 0, failed: [], aborted: false, ctl: new AbortController(), frac: 0, phase: '',
    abort() { this.aborted = true; this.ctl.abort(); },
    wait(ms, attempt) { progress(`Rate limited by FMP · retrying in ${Math.round(ms / 1000)} s (attempt ${attempt} of 3)`, this.frac); } };
  const step = (text, frac) => { run.phase = text; run.frac = frac; progress(text, frac); };
  const failed = run.failed;
  try {
    // 1. Quotes for the whole preserved universe (100 symbols per request).
    const symbols = state.universe.stocks.map(s => s.t), quotes = {};
    for (let i = 0; i < symbols.length; i += 100) {
      step(`Refreshing · quotes ${Math.min(i + 100, symbols.length)}/${symbols.length}`, i / symbols.length * .3);
      for (const q of await fmp('batch-quote', { symbols: symbols.slice(i, i + 100).join(',') }, key, run)) quotes[q.symbol] = q;
    }
    const dateOf = {}, freq = {};
    for (const [t, q] of Object.entries(quotes)) {
      if (!(q.price > 0) || !q.timestamp) continue;
      dateOf[t] = nyDate(q.timestamp); freq[dateOf[t]] = (freq[dateOf[t]] || 0) + 1;
    }
    const Q = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    if (!Q) throw new FmpError('http', 'FMP returned no usable quotes');
    if (Q < L) throw new FmpError('http', `Quotes are dated ${fmtDate(Q)}, before the stored history (${fmtDate(L)})`);
    const ts = Math.max(...Object.entries(quotes).filter(([t]) => dateOf[t] === Q).map(([, q]) => q.timestamp));

    // 2. Which sessions lie between the stored history and the quote session? Two reference
    //    names' daily history, checked against each other and the calendar before it is trusted.
    let gap = [];
    if (Q > L) {
      step('Refreshing · checking sessions', .32);
      const seen = new Set(); let anchored = false;
      for (const ref of REF_SYMBOLS) {
        const rows = await fmp('historical-price-eod/light', { symbol: ref, from: L, to: Q }, key, run);
        for (const r of rows) { if (r.date === L) anchored = true; if (r.date > L && r.date < Q) seen.add(r.date); }
      }
      if (!anchored) throw new FmpError('http', 'FMP returned no session data for the reference names; nothing was changed');
      gap = [...seen].sort();
      const weekdays = weekdaysBetween(L, Q);
      if (weekdays - gap.length > Math.ceil(weekdays / 20) + 1) throw new FmpError('http', `FMP history looks incomplete (${gap.length} of ${weekdays} weekdays since ${fmtDate(L)}); nothing was changed`);
    }
    const dates = Q > L ? [...hist.dates, ...gap, Q] : hist.dates.slice(), N = dates.length, idx = new Map(dates.map((d, k) => [d, k]));
    // The stored value for L is an intraday snapshot when the last refresh ran during the session:
    // it is replaced by the official close (previousClose when Q follows L directly, else re-fetched).
    const refetchL = Q > L && intradayL && gap.length > 0;
    // Per-name history requests use FMP's dividend- and split-adjusted series and start one stored
    // session before what they must fill: that overlapping session is the anchor. If FMP's adjusted
    // value for the anchor differs from the stored one, a dividend (or split) has gone ex since, and
    // every earlier stored value is rescaled by the same factor, keeping the whole series adjusted.
    // At least every RECONCILE_SESSIONS sessions this is done for every name.
    // The anchor is the session before the last recorded adjustment pass: every stored value up to
    // it came from FMP's adjusted series, so FMP's value there moves only if a dividend or split
    // went ex after it, including on sessions appended by quotes-only refreshes since. It is never
    // the last stored session, whose value is a quote.
    const recIdx = Math.max(0, Math.min(T - 2, hist.dates.indexOf(state.asOf.reconciled || '') - 1)), anchor = hist.dates[recIdx];
    const sinceReconcile = hist.dates.filter(d => d > (state.asOf.reconciled || '')).length + (Q > L ? gap.length + 1 : 0);
    const pending = new Set(state.asOf.pending || []);             // names whose last adjustment fetch failed
    const reconcileAll = sinceReconcile >= RECONCILE_SESSIONS;

    // 3. Extend every series; note which names need a history request.
    const px = {}, need = [];
    for (const t of symbols) {
      const old = hist.px[t], q = quotes[t], d = dateOf[t];
      if (!old) { px[t] = new Array(N).fill(null); need.push({ t, from: dates[0], full: true }); continue; }
      const arr = old.slice();
      if (Q > L) {
        if (gap.length === 0 && d === Q && q.previousClose > 0) arr[arr.length - 1] = q.previousClose;   // L's official close
        if (gap.length === 1) arr.push(d === Q && q.previousClose > 0 && !refetchL ? q.previousClose : null);
        else if (gap.length > 1) for (const _ of gap) arr.push(null);
        if (refetchL || gap.length > 1 || reconcileAll || pending.has(t)) need.push({ t, from: anchor, to: Q });
        arr.push(d === Q ? q.price : d > Q && q.previousClose > 0 ? q.previousClose : null);
      } else {
        if (d === Q) arr[arr.length - 1] = q.price;
        if (reconcileAll || pending.has(t)) need.push({ t, from: anchor, to: Q });
      }
      px[t] = arr;
      // Repair: a hole in the last few sessions (a name that had no quote last time) is refilled.
      if (!need.some(x => x.t === t) && arr.slice(Math.max(0, N - 7), N - (Q > L ? 1 : 0)).some(v => v === null)) need.push({ t, from: anchor, to: Q });
    }
    // Adjusted closes from FMP overwrite the requested range; values before the anchor are rescaled
    // when the anchor moved; the quote stays the freshest value for Q.
    const applyRows = (t, rows, from, replace) => {
      const a = px[t];
      if (replace) a.fill(null);
      else {
        const k0 = idx.get(from) ?? N;
        let ka = -1, factor = 1;
        for (const r of rows) { const k = idx.get(r.date); if (k !== undefined && k >= k0 && k < N - 1 && r.adjClose > 0 && a[k] > 0 && (ka < 0 || k < ka)) { ka = k; factor = r.adjClose / a[k]; } }
        if (ka >= 0 && Math.abs(factor - 1) > 5e-4) for (let k = 0; k < ka; k++) if (a[k] > 0) a[k] = a[k] * factor;
      }
      for (const r of rows) { const k = idx.get(r.date); if (k !== undefined && r.adjClose > 0 && (replace || k >= (idx.get(from) ?? N))) a[k] = r.adjClose; }
      if (dateOf[t] === Q && quotes[t].price > 0) a[N - 1] = quotes[t].price;
    };
    if (need.length) {
      let done = 0;
      step(`Refreshing · ${reconcileAll ? 'adjustments' : 'history'} 0/${need.length}`, .35);
      await mapLimit(need, 5, run, async item => {
        const params = { symbol: item.t, from: item.from }; if (item.to) params.to = item.to;
        applyRows(item.t, await fmp(ADJ, params, key, run), item.from, !!item.full);
        done++; step(`Refreshing · ${reconcileAll ? 'adjustments' : 'history'} ${done}/${need.length}`, .35 + .55 * done / need.length);
      });
    }
    // 4. A new move beyond ±40% is most likely a split: re-download that name's adjusted history.
    const suspects = symbols.filter(t => !need.some(x => x.t === t && x.full) && px[t].some((v, k) => k >= T - 1 && k > 0 && v > 0 && px[t][k - 1] > 0 && Math.abs(Math.log(v / px[t][k - 1])) > SPLIT_JUMP));
    if (suspects.length) {
      step(`Refreshing · checking ${suspects.length} possible splits`, .92);
      await mapLimit(suspects.map(t => ({ t })), 5, run, async item => {
        applyRows(item.t, await fmp(ADJ, { symbol: item.t, from: dates[0] }, key, run), dates[0], true);
      });
    }
    // 5. Keep a bounded window, persist, recompute.
    const cut = Math.max(0, N - MAX_SESSIONS);
    const next = { dates: dates.slice(cut), px: Object.fromEntries(Object.entries(px).filter(([, a]) => a.some(v => v > 0)).map(([t, a]) => [t, a.slice(cut)])) };
    state.history = next;
    // A full pass records the adjustment date; names whose fetch failed are retried next time.
    const everyName = symbols.every(t => need.some(x => x.t === t)), failedSet = new Set(failed);
    const stillPending = everyName ? failed.filter(t => need.some(x => x.t === t)) : [...pending].filter(t => !need.some(x => x.t === t) || failedSet.has(t));
    state.asOf = { session: Q, ts, refreshedAt: new Date().toISOString(), requests: run.n, reconciled: everyName ? Q : (state.asOf.reconciled || hist.dates[0]), pending: [...new Set(stillPending)] };
    let saved = true;
    try { await Promise.all([idb.set('history', encodeBundle(next)), idb.set('meta', state.asOf)]); } catch { saved = false; }
    state.busy = false; progress('');
    // Rows whose latest price moved flash briefly after the re-render.
    state.flash = new Map();
    for (const t of symbols) { const a = hist.px[t], b = next.px[t]; if (a && b) { const d = b[b.length - 1] - a[a.length - 1]; if (d && a[a.length - 1] > 0 && b[b.length - 1] > 0) state.flash.set(t, d); } }
    rebuild();
    refreshDone(true);
    const uniq = [...new Set(failed)];
    const fail = uniq.length ? ` · ${uniq.length} name${uniq.length > 1 ? 's' : ''} failed` : '';
    const msg = `Updated · ${fmtDate(Q)} ${isIntraday() ? nyTime(ts) : 'close'} · ${run.n} request${run.n === 1 ? '' : 's'}${fail}${saved ? '' : ' · not saved: browser storage unavailable, data resets on reload'}`;
    const cls = uniq.length || !saved ? 'err' : 'ok';
    if (openSheetId === 'sheet-data') { renderDataSheet(); setNote('refresh-note', msg, cls); }
    else toast(msg, cls === 'ok' ? 'ok' : '');
  } catch (e) {
    run.abort();
    state.busy = false; progress('');
    refreshDone(false);
    const msg = e instanceof FmpError ? e.message : `Refresh failed: ${e.message}`;
    if (e.kind === 'key') { openSheet('sheet-data'); setNote('key-note', 'FMP rejected this key. Check it and save again.', 'err'); }
    if (openSheetId === 'sheet-data') { $('do-refresh').disabled = !getKey(); $('do-refresh').textContent = 'Refresh prices'; setNote('refresh-note', msg, 'err'); }
    else toast(msg, 'err');
  }
}

/** The refresh icon morphs into a check (or shakes) for a moment when a refresh ends. */
let okTimer = null;
function refreshDone(ok) {
  const btn = $('btn-refresh'), use = btn.querySelector('use');
  const restore = () => { use.setAttribute('href', '#i-refresh'); btn.classList.remove('ok'); };
  clearTimeout(okTimer);
  if (ok === null || !MOTION) { restore(); return; }            // null: a refresh is starting, just reset
  if (ok) {
    use.setAttribute('href', '#i-check'); btn.classList.add('ok');
    btn.animate([{ transform: 'scale(.8)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 360, easing: EASE });
    okTimer = setTimeout(restore, 1400);
  } else { restore(); btn.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 300 }); }
}

// ---- membership check (manual; reports only, changes nothing) ----------------------------
/** The S&P 400 constituents from Wikipedia's table, parsed in the browser. */
async function fetchSp400() {
  const r = await fetch(SP400_API);
  if (r.status === 429) throw new Error('Wikipedia is rate-limiting requests right now; try again in a minute');
  if (!r.ok) throw new Error(`Wikipedia replied ${r.status}`);
  const html = (await r.json()).parse.text;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.getElementById('constituents');
  if (!table) throw new Error('Could not find the constituents table on Wikipedia');
  const head = [...table.querySelectorAll('tr')][0].children, col = {};
  [...head].forEach((c, i) => { const h = c.textContent.toLowerCase(); if (h.includes('symbol')) col.symbol = i; if (h.includes('security')) col.name = i; });
  if (col.symbol === undefined) throw new Error('Unexpected table layout on Wikipedia');
  const out = [];
  for (const tr of [...table.querySelectorAll('tr')].slice(1)) {
    const c = tr.children; if (c.length <= col.symbol) continue;
    out.push({ t: c[col.symbol].textContent.trim().replace(/\./g, '-'), n: col.name !== undefined ? c[col.name].textContent.trim() : '' });
  }
  if (out.length < 350) throw new Error(`Only ${out.length} S&P 400 rows parsed`);
  return out;
}
const classKey = n => n.trim().toLowerCase().replace(/\s*\(class [a-z]\)\s*$/, '');
async function checkMembership() {
  const key = getKey(), note = 'member-note', btn = $('do-members');
  if (!key) { setNote(note, 'Add your FMP key first: the S&P 500 list comes from FMP.', 'err'); return; }
  btn.disabled = true; setNote(note, 'Checking the S&P 500 (FMP) and S&P 400 (Wikipedia) lists…');
  const run = { n: 0, aborted: false, ctl: new AbortController(), abort() { this.aborted = true; this.ctl.abort(); },
    wait(ms, attempt) { setNote(note, `Rate limited by FMP · retrying in ${Math.round(ms / 1000)} s (attempt ${attempt} of 3)`); } };
  try {
    const [sp500, sp400] = await Promise.all([fmp('sp500-constituent', {}, key, run), fetchSp400()]);
    if (!Array.isArray(sp500) || sp500.length < 450) throw new Error(`FMP returned only ${Array.isArray(sp500) ? sp500.length : 0} S&P 500 names; not compared`);
    const live = new Map();
    for (const c of sp500) live.set(c.symbol, { t: c.symbol, n: c.name || '', i: '500' });
    for (const c of sp400) if (!live.has(c.t)) live.set(c.t, { t: c.t, n: c.n, i: '400' });
    // The bundle keeps one share class per company: a second class of a company already
    // represented is not an addition.
    const bundled = new Map(state.universe.stocks.map(s => [s.t, s]));
    const bundledCompanies = new Set(state.universe.stocks.map(s => classKey(s.n)));
    // A live symbol is a redundant second class only if the bundled company is still in the live
    // lists; otherwise it is a rename or class swap and shows up as an add beside the drop.
    const stillLive = new Set(state.universe.stocks.filter(s => live.has(s.t)).map(s => classKey(s.n)));
    const seen = new Set();
    const adds = [...live.values()].filter(c => !bundled.has(c.t) && !stillLive.has(classKey(c.n))).filter(c => { const k = classKey(c.n); if (seen.has(k)) return false; seen.add(k); return true; });
    const drops = state.universe.stocks.filter(s => !live.has(s.t));
    const moves = state.universe.stocks.filter(s => live.has(s.t) && live.get(s.t).i !== s.i);
    const list = (arr, f) => arr.slice(0, 20).map(f).join(', ') + (arr.length > 20 ? ` … and ${arr.length - 20} more` : '');
    const nb = x => x.replace(/ /g, '\u00a0');
    const parts = [];
    if (adds.length) parts.push(`${adds.length} to add: ${list(adds, c => nb(`${c.t} (${c.i})`))}`);
    if (drops.length) parts.push(`${drops.length} to drop: ${list(drops, s => s.t)}`);
    if (moves.length) parts.push(`${moves.length} moved: ${list(moves, s => nb(`${s.t} ${s.i}→${live.get(s.t).i}`))}`);
    setNote(note, parts.length ? `${parts.join('.\n')}.\nNothing was changed: rebuild the data bundle to apply (${run.n + 1} requests).`
      : `The bundle matches today's S&P 500 and 400 lists (${live.size} names, ${run.n + 1} requests).`, parts.length ? '' : 'ok');
  } catch (e) { setNote(note, e.message || 'Check failed', 'err'); }
  finally { run.abort(); btn.disabled = !getKey(); $(note).scrollIntoView({ block: 'nearest' }); }
}

// ---- wiring ----------------------------------------------------------------------------
function wire() {
  const toggleSettings = () => openSheetId === 'sheet-settings' ? closeSheet() : openSheet('sheet-settings');
  $('btn-settings').onclick = toggleSettings;
  $('chips').onclick = toggleSettings;
  $('status').onclick = () => openSheet('sheet-data');
  dragToDismiss($('sheet-settings')); dragToDismiss($('sheet-data'));
  $('btn-refresh').onclick = () => refresh();
  $('do-refresh').onclick = () => refresh();
  $('do-members').onclick = () => checkMembership();
  $('backdrop').onclick = closeSheet;
  // A tap outside the compact settings panel closes it (scrolling the list does not).
  document.addEventListener('click', e => {
    if (openSheetId !== 'sheet-settings') return;
    if (e.target.closest('#sheet-settings, #btn-settings, #chips')) return;
    closeSheet();
  });
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  document.querySelectorAll('[data-window]').forEach(b => b.onclick = () => setSettings({ window: b.dataset.window }));
  document.querySelectorAll('#sheet-settings [data-display]').forEach(b => b.onclick = () => setSettings({ display: b.dataset.display }));
  document.querySelectorAll('[data-factors]').forEach(b => b.onclick = () => setSettings({ factors: b.dataset.factors }));
  document.querySelectorAll('[data-flag]').forEach(i => i.onchange = () => setSettings({ [i.dataset.flag]: i.checked }));
  $('reset').onclick = () => setSettings({ ...DEFAULT_SETTINGS });
  document.querySelectorAll('#sheet-settings [data-theme]').forEach(b => b.onclick = () => { store.set('theme', b.dataset.theme); applyTheme(); });
  const scheme = matchMedia('(prefers-color-scheme: light)');
  if (scheme.addEventListener) scheme.addEventListener('change', applyTheme);
  applyTheme();
  document.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { state.scope.index = b.dataset.scope; recompute(); });
  $('filter-clear').onclick = () => { state.scope.group = null; state.prevPoolKey = ''; recompute(); const li = $('list').querySelector('li[data-t]'); if (li) li.focus({ preventScroll: true }); };
  $('search').oninput = e => { state.query = e.target.value; renderList(); };
  const pick = li => { if (li.dataset.g) { state.scope.group = li.dataset.t; state.query = ''; $('search').value = ''; recompute(); window.scrollTo({ top: 0 }); $('filter-clear').focus({ preventScroll: true }); } else openDetail(li.dataset.t); };
  $('list').onclick = e => { const li = e.target.closest('li[data-t]'); if (li) pick(li); };
  $('list').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { const li = e.target.closest('li[data-t]'); if (li) { e.preventDefault(); pick(li); } } };
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { state.view = b.dataset.view; store.set('view', state.view); state.scope.group = null; state.prevPoolKey = ''; recompute(); });
  $('d-back').onclick = () => closeDetail();
  window.onpopstate = () => { const t = location.hash.slice(1); if (t && state.model && state.model.byTicker.has(t)) openDetail(t, false); else closeDetail(false); };
  document.onkeydown = e => {
    if (e.key === 'Escape') { if (openSheetId) closeSheet(); else if (state.cur) closeDetail(); }
    else if (state.cur && !openSheetId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input')) navTo(e.key === 'ArrowRight' ? 1 : -1);
  };
  $('d-prev').onclick = () => navTo(-1); $('d-next').onclick = () => navTo(1);
  $('d-star').onclick = () => toggleWatch(state.cur);
  $('watch-filter').onclick = () => { state.watchOnly = !state.watchOnly; renderList(); };
  // A horizontal swipe over the chart moves to the previous / next ticker.
  let sx = null, sy = null;
  $('detail').addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && e.target.closest('.chart-wrap, .d-price, .d-name')) { sx = e.clientX; sy = e.clientY; } else sx = null; });
  $('detail').addEventListener('pointerup', e => { if (sx === null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null; if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) navTo(dx < 0 ? 1 : -1); });
  $('key-save').onclick = async () => {
    const k = $('key').value.trim();
    if (!k) { setNote('key-note', 'Paste a key first.', 'err'); return; }
    store.set('fmpKey', k); renderDataSheet(); setNote('key-note', 'Saved. Testing the key with one quote request…');
    const run = { n: 0, aborted: false, ctl: new AbortController() };
    try { await fmp('batch-quote', { symbols: 'AAPL' }, k, run); setNote('key-note', 'Key accepted by FMP (1 request). Press Refresh prices to use it.', 'ok'); }
    catch (e) { setNote('key-note', e.kind === 'key' ? 'FMP rejected this key. Check it and save again.' : `Saved, but the test failed: ${e.message}`, 'err'); }
  };
  $('key').onkeydown = e => { if (e.key === 'Enter') $('key-save').click(); };
  $('key-clear').onclick = () => { store.del('fmpKey'); renderDataSheet(); setNote('key-note', 'Key removed.'); };
  const bar = document.createElement('div'); bar.className = 'progress'; bar.id = 'refresh-progress'; bar.innerHTML = '<i></i>'; bar.hidden = true;
  $('refresh-note').after(bar);
  let rt = null;
  window.onresize = () => { clearTimeout(rt); rt = setTimeout(() => { if (!state.model) return; renderHist(); layoutPills(); if (state.cur) drawChart(state.cur);
    if (openSheetId === 'sheet-settings') document.documentElement.style.setProperty('--sheet-h', `${$('sheet-settings').offsetHeight}px`); }, 120); };
}

async function init() {
  wire();
  $('list').innerHTML = Array.from({ length: 12 }, (_, i) => `<li class="row"><span class="rk">${i + 1}</span><span class="id"><span class="sk" style="width:${40 + (i * 13) % 30}px"></span><span class="sk" style="width:${90 + (i * 29) % 80}px;height:9px"></span></span><span class="val"><span class="sk" style="width:56px"></span></span></li>`).join('');
  $('list').classList.add('skeleton');
  try {
    state.firstPaint = true;
    await loadData();
    $('list').classList.remove('skeleton');
    const t = location.hash.slice(1);
    if (t && state.model.byTicker.has(t)) openDetail(t, false);
  } catch (e) {
    $('list').classList.remove('skeleton');
    $('list').innerHTML = `<li class="empty">Could not load the data bundle.<br>${esc(e.message)}</li>`;
    $('status-text').textContent = 'Data unavailable';
  }
}
init();

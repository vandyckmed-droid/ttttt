// S&P 900 Momentum — page logic. The model lives in model.js; this file loads
// data, renders, and runs the user-initiated refresh against FMP.
import {
  MODEL, DEFAULT_SETTINGS, decodePrices, encodePrices, buildModel, rankPool, scoreStock,
  displayValue, excludeReason,
} from './model.js';

const FMP = 'https://financialmodelingprep.com/stable/';
const REF_SYMBOL = 'AAPL';          // one history call tells us which sessions a refresh must fill
const MAX_SESSIONS = 800;           // keep a little more than the 3-year regression window
const SPLIT_JUMP = Math.log(1.4);   // a new daily move beyond ±40% triggers a full re-download of that name
const HORIZONS = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, '3Y': 756 };
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
  async run(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      });
    } catch { return undefined; }
  },
  get(k) { return this.run('readonly', s => s.get(k)); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
  del(k) { return this.run('readwrite', s => s.delete(k)); },
};

// ---- state -------------------------------------------------------------------
const state = {
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  hz: store.get('hz', '6M'),
  showBench: store.get('showBench', false),
  scope: { index: 'all', group: null },
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
const getKey = () => store.get('fmpKey', '');

// ---- formatting --------------------------------------------------------------
const sign = v => v < 0 ? '−' : '+';
const fmtPct = (v, d = 1) => sign(v) + (Math.abs(v) * 100).toFixed(d) + '%';
const fmtNum = (v, d = 2) => sign(v) + Math.abs(v).toFixed(d);
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
  return d === 'z' ? fmtNum(row.z) : d === 'pct' ? `${Math.floor(row.pct)}%` : d === 'rank' ? `#${row.rank}` : fmtScore(row.score);
};
const displayLabel = () => ({ raw: state.settings.vol ? 'Vol-adjusted score' : 'Annualized log return', z: 'Z-score', pct: 'Percentile', rank: 'Rank' })[state.settings.display];
const windowLabel = () => ({ '6m': '6M', '12m': '12M', blend: '6M+12M' })[state.settings.window];
const isIntraday = () => state.asOf && state.asOf.ts && nyDate(state.asOf.ts) === state.asOf.session && nyHour(state.asOf.ts) < 16;

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
  if (stored && stored.dates && stored.dates[stored.dates.length - 1] >= seed.dates[seed.dates.length - 1]) {
    state.history = decodeBundle(stored);
    state.asOf = meta || { session: stored.dates[stored.dates.length - 1] };
  } else {
    if (stored) { idb.del('history'); idb.del('meta'); }
    state.history = decodeBundle(seed);
    state.asOf = { session: seed.dates[seed.dates.length - 1] };
  }
  rebuild();
}

function rebuild() {
  state.model = buildModel(state.universe, state.history);
  recompute();
}

// ---- ranking -------------------------------------------------------------------
const poolKey = () => `${state.scope.index}|${state.scope.group || ''}|${JSON.stringify(state.settings)}`;
function pool() {
  const { index, group } = state.scope;
  return state.model.stocks.filter(s => (index === 'all' || s.i === index) && (!group || s.g === group)).map(s => s.t);
}
function recompute() {
  const scopeKey = `${state.scope.index}|${state.scope.group || ''}`;
  state.prevRank = scopeKey === state.prevPoolKey ? new Map(state.ranking.rows.map(r => [r.t, r.rank])) : null;
  state.prevPoolKey = scopeKey;
  state.ranking = rankPool(state.model, pool(), state.settings);
  state.rowByTicker = new Map(state.ranking.rows.map(r => [r.t, r]));
  render();
}

// ---- rendering -----------------------------------------------------------------
function render() {
  renderStatus(); renderChips(); renderHist(); renderList(); renderScope(); renderFilter();
  if (state.cur) renderDetail(state.cur, true);
}

function renderStatus() {
  const a = state.asOf;
  $('status-text').textContent = state.busy ? state.busyText
    : `${fmtDate(a.session, { month: 'short', day: 'numeric' })} ${isIntraday() ? 'live' : 'close'} · ${a.refreshedAt ? 'updated ' + ago(a.refreshedAt) : 'not refreshed'}`;
  $('btn-refresh').classList.toggle('busy', state.busy);
}

function renderChips() {
  const s = state.settings, chips = [[windowLabel(), true]];
  if (s.skip) chips.push(['Skip 21', true]);
  if (s.residual) chips.push(['Residual', true]);
  if (s.vol) chips.push(['Vol-adj', true]);
  if (s.r2) chips.push(['× R²', true]);
  if (s.display !== 'raw') chips.push([displayLabel(), false]);
  $('chips').innerHTML = chips.map(([c, on]) => `<span class="chip${on ? ' on' : ''}">${esc(c)}</span>`).join('');
  $('dist-n').textContent = `${state.ranking.rows.length} ranked`;
}

/** Histogram of the pool's raw scores; the marked value's bin is highlighted. */
function histogramSVG(values, { mark = null, width = 360, height = 56, bins = 48, labels = true } = {}) {
  const n = values.length;
  if (!n) return '';
  const s = values.slice().sort((a, b) => a - b);
  let lo = s[Math.round(0.01 * (n - 1))], hi = s[Math.round(0.99 * (n - 1))];
  if (!(hi > lo)) { lo -= 1e-6; hi += 1e-6; }
  const counts = new Array(bins).fill(0), bin = v => Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * bins)));
  for (const v of values) counts[bin(v)]++;
  const max = Math.max(...counts), bw = width / bins, top = labels ? height - 14 : height, gap = 1.2;
  let out = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
  const markBin = mark === null ? -1 : bin(mark);
  counts.forEach((c, i) => {
    const h = Math.max(c ? 2 : 0, c / max * top), x = i * bw, center = lo + (i + .5) * (hi - lo) / bins;
    out += `<rect class="${i === markBin ? 'mark' : center >= 0 ? 'pos' : 'neg'}" x="${(x + gap / 2).toFixed(1)}" y="${(top - h).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
  });
  if (lo < 0 && hi > 0) { const zx = (0 - lo) / (hi - lo) * width; out += `<line class="zero" x1="${zx.toFixed(1)}" x2="${zx.toFixed(1)}" y1="0" y2="${top}"/>`; }
  if (labels) out += `<text x="0" y="${height - 2}">${esc(fmtScore(lo))}</text><text x="${width}" y="${height - 2}" text-anchor="end">${esc(fmtScore(hi))}</text>`;
  return out + '</svg>';
}
function renderHist() { $('hist').innerHTML = histogramSVG(state.ranking.rows.map(r => r.score), { width: $('hist').clientWidth || 360 }); }

function renderScope() {
  document.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', b.dataset.scope === state.scope.index));
}
function renderFilter() {
  const g = state.scope.group;
  $('filter').hidden = !g;
  if (g) $('filter-text').innerHTML = `Peer group · <b>${esc(g)}</b>`;
}

function rowHTML(row) {
  const s = state.universe.stocks && state.model.byTicker.get(row.t), raw = row.score;
  const cls = raw > 0 ? 'up' : raw < 0 ? 'dn' : 'flat';
  const sub = state.settings.display === 'pct' ? fmtScore(raw) : state.settings.display === 'rank' ? fmtScore(raw) : `${Math.floor(row.pct)}th pct`;
  let mv = '';
  if (state.prevRank && state.prevRank.has(row.t)) {
    const d = state.prevRank.get(row.t) - row.rank;
    if (d) mv = `<span class="mv ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }
  return `<li class="row" data-t="${esc(row.t)}" role="button" tabindex="0"><span class="rk">${row.rank}</span>` +
    `<span class="id"><span class="tk">${esc(row.t)}${mv}</span><span class="nm">${esc(s ? s.n : '')}</span></span>` +
    `<span class="val"><span class="sc ${cls}">${displayText(row)}</span><span class="sub">${esc(sub)}</span></span></li>`;
}
function renderList() {
  const q = state.query.trim().toUpperCase();
  let rows = state.ranking.rows, extra = '';
  if (q) {
    const match = t => t.startsWith(q) || (state.model.byTicker.get(t) || { n: '' }).n.toUpperCase().includes(q);
    rows = rows.filter(r => match(r.t));
    extra = state.ranking.excluded.filter(x => match(x.t)).map(x => {
      const s = state.model.byTicker.get(x.t);
      return `<li class="row" data-t="${esc(x.t)}" role="button" tabindex="0"><span class="rk">—</span><span class="id"><span class="tk">${esc(x.t)}</span><span class="nm">${esc(s.n)}</span></span>` +
        `<span class="val"><span class="sc flat">—</span><span class="sub">${esc(x.reason)}</span></span></li>`;
    }).join('');
  }
  $('list').innerHTML = rows.length || extra ? rows.map(rowHTML).join('') + extra
    : `<li class="empty">${q ? 'No matches.' : 'Nothing to rank with these settings.'}</li>`;
  const ex = state.ranking.excluded.length, noHist = state.universe.stocks.length - state.model.stocks.length;
  const bits = [];
  if (ex) bits.push(`${ex} not ranked (insufficient history${state.settings.residual || state.settings.r2 ? ' or benchmark' : ''})`);
  if (noHist) bits.push(`${noHist} without price data — refresh to fetch`);
  $('foot').textContent = bits.join(' · ');
}

// ---- detail page -----------------------------------------------------------------
function openDetail(t, push = true) {
  if (!state.model.byTicker.has(t)) return;
  state.cur = t;
  renderDetail(t);
  $('detail').classList.add('on'); $('detail').setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
  if (push && location.hash !== '#' + t) history.pushState({ t }, '', '#' + t);
  $('d-body').scrollTop = 0;
}
function closeDetail(pop = true) {
  if (!state.cur) return;
  state.cur = null;
  $('detail').classList.remove('on'); $('detail').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('locked');
  if (pop && location.hash) history.back();
}

function renderDetail(t, keepScroll = false) {
  const s = state.model.byTicker.get(t), p = state.history.px[t], T = state.model.T, fit = state.model.fits.get(t);
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
    <div class="big"><b class="${row.score > 0 ? 'up' : row.score < 0 ? 'dn' : ''}">${displayText(row)}</b><span>#${row.rank} of ${state.ranking.rows.length}<br>${Math.floor(row.pct)}th percentile</span></div>
    <div class="histo mini">${histogramSVG(state.ranking.rows.map(r => r.score), { mark: row.score, width: Math.max(200, $('d-body').clientWidth - 64), height: 40, labels: false })}</div>
    <div class="kv"><span>${esc(displayLabel())}</span><b>${displayText(row)}</b></div>
    ${state.settings.display !== 'raw' ? `<div class="kv"><span>${esc(state.settings.vol ? 'Vol-adjusted score' : 'Annualized log return')}</span><b>${fmtScore(row.score)}</b></div>` : ''}
    <div class="kv"><span>Z-score</span><b>${fmtNum(row.z)}</b></div>
    ${Object.entries(parts).map(([w, m]) => `<div class="kv"><span>${w.toUpperCase()} stock return<span class="hint">${m.n} sessions${state.settings.skip ? ', last 21 skipped' : ''}</span></span>` +
      `<b>${fmtPct(m.stock)}${state.settings.residual ? `<span class="hint">benchmark ${fmtPct(m.bench)} · residual ${fmtPct(m.signal)}</span>` : ''}` +
      `<span class="hint">vol ${(m.sd * Math.sqrt(MODEL.YEAR) * 100).toFixed(1)}% ann.</span></b></div>`).join('')}
    <div class="chipline">${[[windowLabel(), 1], ['Skip 21', state.settings.skip], ['Residual', state.settings.residual], ['Vol-adj', state.settings.vol], ['× R²', state.settings.r2]]
      .filter(([, on]) => on).map(([c]) => `<span class="chip on">${esc(c)}</span>`).join('')}</div>`
    : `<p class="note">${inPool ? `Not ranked: ${esc(excludeReason(state.model, t, state.settings))}.` : 'Outside the current universe filter.'}</p>`;

  const lvl = { peer: 'Peer group', sector: 'Sector', universe: 'S&P 900' };
  const regCard = `
    ${fit.level ? `<div class="bench"><span class="bench-lv">${lvl[fit.level]} benchmark</span><b>${esc(fit.name)}</b><span class="hint">Equal-weight, leave-one-out · ${fit.peers} peers${fit.level !== 'peer' ? ` · ${esc(fit.tried[0].reason)}` : ''}</span></div>
    <div class="kv"><span>Beta</span><b>${fit.beta.toFixed(2)}</b></div>
    <div class="kv"><span>Alpha (annualized)</span><b>${fmtPct(fit.alpha * MODEL.YEAR)}</b></div>
    <div class="kv"><span>R²</span><b>${fit.r2.toFixed(2)}</b></div>
    <div class="kv"><span>Observations</span><b>${fit.n}<span class="hint">daily, last ${MODEL.BETA_WINDOW} sessions</span></b></div>`
    : `<p class="note">No viable benchmark: this name has too little overlapping history for a ${MODEL.BETA_WINDOW}-session regression (min ${MODEL.MIN_OBS} sessions).</p>`}
    <ul class="tried">${fit.tried.map(x => `<li class="${x.level === fit.level ? 'used' : ''}"><span class="lv">${x.level}</span><span class="nm">${esc(x.name || '')}</span><span class="why">${x.ok ? `β ${x.beta.toFixed(2)} · R² ${x.r2.toFixed(2)}${x.level === fit.level ? ' · used' : ''}` : esc(x.reason)}</span></li>`).join('')}</ul>
    <p class="note">The peer group is used when it has at least ${MODEL.MIN_PEERS} other names and ${MODEL.MIN_OBS} overlapping sessions; otherwise the sector, otherwise the whole S&P 900.</p>`;

  $('d-body').innerHTML = `
    <p class="d-name">${esc(s.n)}</p>${priceBlock}
    <div class="chart-head"><span class="hzc num" id="hzc"></span><span class="hzl" id="hzl"></span></div>
    <div class="chart-wrap" id="chart"></div>
    <div class="chart-ctl">
      <div class="seg" role="group" aria-label="Chart window">${Object.keys(HORIZONS).map(h => `<button type="button" data-hz="${h}" aria-pressed="${h === state.hz}">${h}</button>`).join('')}</div>
      <button class="toggle" id="bench-toggle" type="button" aria-pressed="${state.showBench}" ${fit.bench ? '' : 'disabled'}><span class="sw"></span>Benchmark</button>
    </div>
    <section class="card"><h3>Momentum</h3>${momCard}</section>
    <section class="card"><h3>Regression · 3 years</h3>${regCard}</section>
    <section class="card"><h3>Company</h3>
      <div class="kv"><span>Index</span><b>S&amp;P ${esc(s.i)}</b></div>
      <div class="kv"><span>Sector</span><b>${esc(s.s)}</b></div>
      <button class="linkrow" id="peers-link" type="button"><span>Peer group</span><b>${esc(s.g || '—')}<svg><use href="#i-chev"/></svg></b></button>
    </section>`;
  drawChart(t);
  document.querySelectorAll('[data-hz]').forEach(b => b.onclick = () => { state.hz = b.dataset.hz; store.set('hz', state.hz); renderDetail(t, true); });
  $('bench-toggle').onclick = () => { state.showBench = !state.showBench; store.set('showBench', state.showBench); renderDetail(t, true); };
  $('peers-link').onclick = () => { if (!s.g) return; state.scope.group = s.g; state.query = ''; $('search').value = ''; closeDetail(); recompute(); window.scrollTo({ top: 0 }); };
  if (keepScroll) $('d-body').scrollTop = scrollTop;
}

function drawChart(t) {
  const box = $('chart'), W = box.clientWidth || 360, H = window.innerWidth >= 720 ? 280 : 230, padT = 24, padB = 20, padL = 6, padR = 6;
  const p = state.history.px[t], dates = state.history.dates, T = state.model.T, fit = state.model.fits.get(t);
  const n = Math.min(HORIZONS[state.hz], T - 1), from = T - 1 - n;
  const ys = p.slice(from), xs = dates.slice(from);
  const first = ys.find(v => v > 0), lastIdx = ys.map(v => v > 0).lastIndexOf(true), last = ys[lastIdx];
  $('hzl').textContent = fmtRange(xs[0], xs[xs.length - 1]);
  if (!(first > 0) || !(last > 0)) { box.innerHTML = '<p class="note">No prices in this window.</p>'; $('hzc').textContent = ''; return; }
  // Benchmark path: the leave-one-out benchmark's cumulative return applied to the stock's first price.
  let bench = null;
  if (state.showBench && fit.bench) {
    bench = new Array(ys.length).fill(null); let acc = Math.log(first), ok = true;
    for (let j = 0; j < ys.length; j++) {
      if (j === 0) { bench[j] = ys[0] > 0 ? first : null; continue; }
      const b = fit.bench[from + j];
      if (b !== b) { ok = false; bench[j] = null; continue; }
      if (!ok) { bench[j] = null; continue; }
      acc += b; bench[j] = Math.exp(acc);
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
<text x="${padL}" y="14">${money(maxV)}</text><text x="${padL}" y="${H - 6}">${money(minV)}</text>
${bench ? `<path class="bl" d="${path(bench)}"/>` : ''}
<path class="ln" d="${d}" stroke="${col}"/>
<g id="hover" style="display:none"><line class="hair" y1="${padT}" y2="${H - padB}"/><circle class="dot" r="4.5" fill="${col}"/></g></svg><div class="tip" id="tip" hidden></div>`;
  const chg = last - first;
  $('hzc').textContent = `${sign(chg)}$${money(Math.abs(chg))} (${fmtPct(chg / first, 2)})`;
  $('hzc').style.color = col;
  const svg = $('csvg'), hov = $('hover'), tip = $('tip');
  const move = e => {
    const r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width * W;
    let i = Math.round((fx - padL) / (W - padL - padR) * (ys.length - 1)); i = Math.max(0, Math.min(ys.length - 1, i));
    let j = i; while (j >= 0 && !(ys[j] > 0)) j--; if (j < 0) return; i = j;
    const x = X(i), y = Y(ys[i]);
    hov.style.display = ''; hov.querySelector('line').setAttribute('x1', x); hov.querySelector('line').setAttribute('x2', x);
    const c = hov.querySelector('circle'); c.setAttribute('cx', x); c.setAttribute('cy', y);
    tip.hidden = false;
    tip.innerHTML = `${esc(fmtDate(xs[i], { month: 'short', day: 'numeric', year: 'numeric' }))} <b>$${money(ys[i])}</b>${bench && bench[i] > 0 ? ` · bench $${money(bench[i])}` : ''}`;
    tip.style.left = Math.max(70, Math.min(W - 70, x)) / W * 100 + '%';
  };
  svg.onpointermove = move; svg.onpointerdown = move;
  svg.onpointerleave = () => { hov.style.display = 'none'; tip.hidden = true; };
}

// ---- sheets -----------------------------------------------------------------------
let openSheetId = null;
function openSheet(id) {
  closeSheet();
  openSheetId = id;
  $('backdrop').hidden = false; $(id).hidden = false;
  requestAnimationFrame(() => $(id).classList.add('on'));
  document.body.classList.add('locked');
  if (id === 'sheet-settings') renderSettings(); else renderDataSheet();
}
function closeSheet() {
  if (!openSheetId) return;
  const el = $(openSheetId); openSheetId = null;
  el.classList.remove('on'); el.hidden = true; $('backdrop').hidden = true;
  if (!state.cur) document.body.classList.remove('locked');
}
function renderSettings() {
  const s = state.settings;
  document.querySelectorAll('[data-window]').forEach(b => b.setAttribute('aria-pressed', b.dataset.window === s.window));
  document.querySelectorAll('[data-display]').forEach(b => b.setAttribute('aria-pressed', b.dataset.display === s.display));
  document.querySelectorAll('[data-flag]').forEach(i => { i.checked = !!s[i.dataset.flag]; });
}
function setSettings(patch) {
  Object.assign(state.settings, patch);
  store.set('settings', state.settings);
  renderSettings();
  recompute();
}

function renderDataSheet() {
  const a = state.asOf, key = getKey(), T = state.model.T;
  $('data-facts').innerHTML = [
    ['Prices through', `${fmtDate(a.session, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} ${isIntraday() ? 'live ' + nyTime(a.ts) : 'close'}`],
    ['History', `${T} sessions · ${state.model.stocks.length} of ${state.universe.stocks.length} stocks`],
    ['Last refresh', a.refreshedAt ? `${ago(a.refreshedAt)} · ${a.requests} requests` : 'never (bundled data)'],
    ['FMP key', key ? `saved · ${key.slice(0, 4)}…` : 'none'],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('do-refresh').disabled = !key || state.busy;
  $('do-refresh').textContent = state.busy ? 'Refreshing…' : 'Refresh prices';
  if (!state.busy) setNote('refresh-note', key
    ? `Fetches the latest quotes for all ${state.universe.stocks.length} stocks with your key (${Math.ceil(state.universe.stocks.length / 100)} requests), plus daily history only for sessions or names that are missing.`
    : 'Add your Financial Modeling Prep key below to refresh prices. Nothing is fetched automatically.');
  $('key').value = '';
  $('key').placeholder = key ? 'Replace saved key' : 'Paste your Financial Modeling Prep key';
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
async function fmp(path, params, key, counter) {
  const u = new URL(FMP + path);
  for (const k in params) u.searchParams.set(k, params[k]);
  u.searchParams.set('apikey', key);
  for (let attempt = 0; ; attempt++) {
    let r;
    counter.n++;
    try { r = await fetch(u); } catch { throw new FmpError('network', 'Network error: could not reach FMP'); }
    if (r.status === 401 || r.status === 403) throw new FmpError('key', 'FMP rejected the API key');
    if (r.status === 402) throw new FmpError('plan', 'Endpoint not included in this FMP plan');
    if (r.status === 429) {
      if (attempt >= 3) throw new FmpError('rate', 'Rate limited by FMP: try again in a minute');
      await sleep(Math.min(30000, 5000 * 2 ** attempt)); continue;
    }
    if (!r.ok) throw new FmpError('http', `FMP error ${r.status}`);
    return r.json();
  }
}
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const j = i++; await fn(items[j], j); } });
  await Promise.all(workers);
}
function progress(text, frac = null) {
  state.busyText = text; renderStatus();
  const bar = $('refresh-progress');
  bar.hidden = !state.busy;
  bar.firstElementChild.style.width = frac === null ? '0' : `${Math.round(frac * 100)}%`;
  if (openSheetId === 'sheet-data') setNote('refresh-note', text);
}

async function refresh() {
  if (state.busy || !state.model) return;
  const key = getKey();
  if (!key) { openSheet('sheet-data'); setNote('refresh-note', 'Add your FMP key below, then press Refresh prices.', 'err'); return; }
  state.busy = true; renderStatus(); if (openSheetId === 'sheet-data') renderDataSheet();
  const counter = { n: 0 }, failed = [], hist = state.history, T = hist.dates.length, L = hist.dates[T - 1];
  try {
    // 1. Quotes for the whole preserved universe (100 symbols per request).
    const symbols = state.universe.stocks.map(s => s.t), quotes = {};
    for (let i = 0; i < symbols.length; i += 100) {
      progress(`Refreshing · quotes ${Math.min(i + 100, symbols.length)}/${symbols.length}`, i / symbols.length * .3);
      for (const q of await fmp('batch-quote', { symbols: symbols.slice(i, i + 100).join(',') }, key, counter)) quotes[q.symbol] = q;
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

    // 2. Which sessions lie between the stored history and the quote session? One reference call.
    let gap = [];
    if (Q > L) {
      progress('Refreshing · checking sessions', .32);
      const ref = await fmp('historical-price-eod/light', { symbol: REF_SYMBOL, from: L, to: Q }, key, counter);
      gap = ref.map(r => r.date).filter(d => d > L && d < Q).sort();
    }
    const dates = Q > L ? [...hist.dates, ...gap, Q] : hist.dates.slice(), N = dates.length, idx = new Map(dates.map((d, k) => [d, k]));

    // 3. Extend every series; note which names need a history request.
    const px = {}, need = [];
    for (const t of symbols) {
      const old = hist.px[t], q = quotes[t], d = dateOf[t];
      if (!old) { px[t] = new Array(N).fill(null); need.push({ t, from: dates[0], full: true }); continue; }
      const arr = old.slice();
      if (Q > L) {
        if (gap.length === 1) arr.push(d === Q && q.previousClose > 0 ? q.previousClose : null);
        else if (gap.length > 1) { for (const _ of gap) arr.push(null); need.push({ t, from: gap[0], to: Q }); }
        arr.push(d === Q ? q.price : d > Q && q.previousClose > 0 ? q.previousClose : null);
      } else if (d === Q) arr[arr.length - 1] = q.price;
      px[t] = arr;
      // Repair: a hole in the last few sessions (a name that had no quote last time) is refilled.
      if (!need.some(x => x.t === t)) {
        const lo = Math.max(0, N - 7);
        if (arr.slice(lo, N - (Q > L ? 1 : 0)).some(v => v === null)) need.push({ t, from: dates[lo], to: Q });
      }
    }
    const applyRows = (t, rows, replace) => {
      if (replace) px[t].fill(null);
      for (const r of rows) { const k = idx.get(r.date); if (k !== undefined && r.price > 0 && (replace || px[t][k] === null)) px[t][k] = r.price; }
      if (dateOf[t] === Q && quotes[t].price > 0) px[t][N - 1] = quotes[t].price;   // the quote is the freshest value for Q
    };
    if (need.length) {
      let done = 0;
      progress(`Refreshing · history 0/${need.length}`, .35);
      await mapLimit(need, 5, async item => {
        try {
          const params = { symbol: item.t, from: item.from }; if (item.to) params.to = item.to;
          applyRows(item.t, await fmp('historical-price-eod/light', params, key, counter), !!item.full);
        } catch (e) { if (e.kind === 'key' || e.kind === 'rate' || e.kind === 'plan') throw e; failed.push(item.t); }
        done++; progress(`Refreshing · history ${done}/${need.length}`, .35 + .55 * done / need.length);
      });
    }
    // 4. A new move beyond ±40% is most likely a split: re-download that name's adjusted history.
    const suspects = symbols.filter(t => !need.some(x => x.t === t && x.full) && px[t].some((v, k) => k >= T - 1 && k > 0 && v > 0 && px[t][k - 1] > 0 && Math.abs(Math.log(v / px[t][k - 1])) > SPLIT_JUMP));
    if (suspects.length) {
      progress(`Refreshing · checking ${suspects.length} possible splits`, .92);
      await mapLimit(suspects, 5, async t => {
        try { applyRows(t, await fmp('historical-price-eod/light', { symbol: t, from: dates[0] }, key, counter), true); }
        catch (e) { if (e.kind === 'key' || e.kind === 'rate' || e.kind === 'plan') throw e; failed.push(t); }
      });
    }
    // 5. Keep a bounded window, persist, recompute.
    const cut = Math.max(0, N - MAX_SESSIONS);
    const next = { dates: dates.slice(cut), px: Object.fromEntries(Object.entries(px).filter(([, a]) => a.some(v => v > 0)).map(([t, a]) => [t, a.slice(cut)])) };
    state.history = next;
    state.asOf = { session: Q, ts, refreshedAt: new Date().toISOString(), requests: counter.n };
    await Promise.all([idb.set('history', encodeBundle(next)), idb.set('meta', state.asOf)]);
    state.busy = false; progress('');
    rebuild();
    const fail = failed.length ? ` · ${failed.length} name${failed.length > 1 ? 's' : ''} failed` : '';
    const msg = `Updated · ${fmtDate(Q)} ${isIntraday() ? nyTime(ts) : 'close'} · ${counter.n} request${counter.n === 1 ? '' : 's'}${fail}`;
    if (openSheetId === 'sheet-data') { renderDataSheet(); setNote('refresh-note', msg, failed.length ? 'err' : 'ok'); }
    else toast(msg, failed.length ? '' : 'ok');
  } catch (e) {
    state.busy = false; progress('');
    const msg = e instanceof FmpError ? e.message : `Refresh failed: ${e.message}`;
    if (e.kind === 'key') { openSheet('sheet-data'); setNote('key-note', 'FMP rejected this key. Check it and save again.', 'err'); }
    if (openSheetId === 'sheet-data') { $('do-refresh').disabled = !getKey(); $('do-refresh').textContent = 'Refresh prices'; setNote('refresh-note', msg, 'err'); }
    else toast(msg, 'err');
  }
}

// ---- wiring ----------------------------------------------------------------------------
function wire() {
  $('btn-settings').onclick = () => openSheet('sheet-settings');
  $('chips').onclick = () => openSheet('sheet-settings');
  $('status').onclick = () => openSheet('sheet-data');
  $('btn-refresh').onclick = () => refresh();
  $('do-refresh').onclick = () => refresh();
  $('backdrop').onclick = closeSheet;
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  document.querySelectorAll('[data-window]').forEach(b => b.onclick = () => setSettings({ window: b.dataset.window }));
  document.querySelectorAll('[data-display]').forEach(b => b.onclick = () => setSettings({ display: b.dataset.display }));
  document.querySelectorAll('[data-flag]').forEach(i => i.onchange = () => setSettings({ [i.dataset.flag]: i.checked }));
  $('reset').onclick = () => setSettings({ ...DEFAULT_SETTINGS });
  document.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => { state.scope.index = b.dataset.scope; recompute(); });
  $('filter-clear').onclick = () => { state.scope.group = null; recompute(); };
  $('search').oninput = e => { state.query = e.target.value; renderList(); };
  $('list').onclick = e => { const li = e.target.closest('li[data-t]'); if (li) openDetail(li.dataset.t); };
  $('list').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { const li = e.target.closest('li[data-t]'); if (li) { e.preventDefault(); openDetail(li.dataset.t); } } };
  $('d-back').onclick = () => closeDetail();
  window.onpopstate = () => { const t = location.hash.slice(1); if (t && state.model && state.model.byTicker.has(t)) openDetail(t, false); else closeDetail(false); };
  document.onkeydown = e => { if (e.key === 'Escape') { if (openSheetId) closeSheet(); else if (state.cur) closeDetail(); } };
  $('key-save').onclick = () => {
    const k = $('key').value.trim();
    if (!k) { setNote('key-note', 'Paste a key first.', 'err'); return; }
    store.set('fmpKey', k); renderDataSheet(); setNote('key-note', 'Key saved in this browser. Press Refresh prices to use it.', 'ok');
  };
  $('key').onkeydown = e => { if (e.key === 'Enter') $('key-save').click(); };
  $('key-clear').onclick = () => { store.del('fmpKey'); renderDataSheet(); setNote('key-note', 'Key removed.'); };
  const bar = document.createElement('div'); bar.className = 'progress'; bar.id = 'refresh-progress'; bar.innerHTML = '<i></i>'; bar.hidden = true;
  $('refresh-note').after(bar);
  let rt = null;
  window.onresize = () => { clearTimeout(rt); rt = setTimeout(() => { if (!state.model) return; renderHist(); if (state.cur) drawChart(state.cur); }, 120); };
}

async function init() {
  wire();
  $('list').innerHTML = Array.from({ length: 12 }, (_, i) => `<li class="row"><span class="rk">${i + 1}</span><span class="id"><span class="sk" style="width:${40 + (i * 13) % 30}px"></span><span class="sk" style="width:${90 + (i * 29) % 80}px;height:9px"></span></span><span class="val"><span class="sk" style="width:56px"></span></span></li>`).join('');
  $('list').classList.add('skeleton');
  try {
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

// Canonical model for the S&P 900 momentum ranker. Pure functions, no DOM:
// the page imports it and so do the tests (node --test).
//
// Pipeline for one stock (see scoreStock):
//   daily log returns -> momentum window -> optional 21-session skip
//   -> optional residual adjustment (beta x leave-one-out benchmark)
//   -> optional division by realized volatility -> optional x R^2
//   -> cross-sectional display transform (raw / z / percentile / rank) -> rank.
//
// Sessions are indexed 0..T-1 over `dates`; a return r[k] covers session k-1 -> k,
// so r[0] is undefined. Missing values are NaN throughout.

export const MODEL = Object.freeze({
  YEAR: 252,                 // trading sessions per year; annualization factor
  WINDOWS: Object.freeze({ '6m': 126, '12m': 252 }),
  SKIP: 21,                  // sessions dropped from the recent end when Skip is on
  BETA_WINDOW: 756,          // ~3 years of daily returns for the regression
  MIN_PEERS: 8,              // a benchmark level is viable only with >= this many other names in it
  MIN_SESSION_PEERS: 4,      // ... and its leave-one-out return on a session needs >= this many others trading
  MIN_OBS: 252,              // a regression needs >= this many overlapping observations
  WINSOR: 0.01,              // z-score display clips at the 1st / 99th percentile
});

const LEVELS = ['peer', 'sector', 'universe'];

export const DEFAULT_SETTINGS = Object.freeze({
  window: 'blend',           // '6m' | '12m' | 'blend' (equal-weight 6m + 12m)
  skip: true,
  residual: false,
  vol: false,
  r2: false,
  display: 'raw',            // 'raw' | 'z' | 'pct' | 'rank'
});

// ---- data ------------------------------------------------------------------

/** Decode data/history.json: delta-coded integer cents -> prices (null = missing). */
export function decodePrices(coded) {
  const out = new Array(coded.length);
  let prev = null;
  for (let k = 0; k < coded.length; k++) {
    const d = coded[k];
    if (d === null || d === undefined) { out[k] = null; continue; }
    prev = prev === null ? d : prev + d;
    out[k] = prev / 100;
  }
  return out;
}

/** Inverse of decodePrices, for persisting extended history compactly. */
export function encodePrices(prices) {
  const out = new Array(prices.length);
  let prev = null;
  for (let k = 0; k < prices.length; k++) {
    const p = prices[k];
    if (p === null || p === undefined || !(p > 0)) { out[k] = null; continue; }
    const cents = Math.round(p * 100);
    out[k] = prev === null ? cents : cents - prev;
    prev = cents;
  }
  return out;
}

/** r[k] = ln(P[k] / P[k-1]); NaN where either price is missing. r[0] is NaN. */
export function logReturns(prices) {
  const T = prices.length, r = new Float64Array(T);
  r[0] = NaN;
  for (let k = 1; k < T; k++) {
    const a = prices[k - 1], b = prices[k];
    r[k] = a > 0 && b > 0 ? Math.log(b / a) : NaN;
  }
  return r;
}

// ---- benchmarks -------------------------------------------------------------

/** Per-session sum and count of valid returns over a set of return series. */
export function aggregate(seriesList, T) {
  const sum = new Float64Array(T), cnt = new Int32Array(T);
  for (const r of seriesList) {
    for (let k = 1; k < T; k++) {
      const v = r[k];
      if (v === v) { sum[k] += v; cnt[k]++; }   // v === v  <=>  !isNaN(v)
    }
  }
  return { sum, cnt };
}

/**
 * Equal-weight leave-one-out benchmark for one stock: on each session the mean
 * return of every other valid member, derived from the aggregates as
 * (sum - r_self) / (count - 1). NaN when fewer than minPeers others are valid
 * that session (MODEL.MIN_SESSION_PEERS; the level itself is gated by MIN_PEERS).
 */
export function looBenchmark(agg, self, minPeers = MODEL.MIN_SESSION_PEERS) {
  const T = agg.sum.length, b = new Float64Array(T);
  b[0] = NaN;
  for (let k = 1; k < T; k++) {
    const v = self[k], own = v === v;
    const n = agg.cnt[k] - (own ? 1 : 0);
    b[k] = n >= minPeers ? (agg.sum[k] - (own ? v : 0)) / n : NaN;
  }
  return b;
}

/** OLS of y on x over sessions [from, to], using pairs where both are valid. */
export function ols(x, y, from, to) {
  let n = 0, sx = 0, sy = 0;
  for (let k = from; k <= to; k++) {
    const a = x[k], b = y[k];
    if (a === a && b === b) { n++; sx += a; sy += b; }
  }
  if (n < 2) return { n, beta: NaN, alpha: NaN, r2: NaN };
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let k = from; k <= to; k++) {
    const a = x[k], b = y[k];
    if (a === a && b === b) { sxx += (a - mx) ** 2; syy += (b - my) ** 2; sxy += (a - mx) * (b - my); }
  }
  const beta = sxx > 0 ? sxy / sxx : NaN;
  return { n, beta, alpha: my - beta * mx, r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN };
}

// ---- model -----------------------------------------------------------------

/**
 * Build the settings-independent part of the model once per data load:
 * returns, benchmark aggregates and each stock's regression against the most
 * specific viable benchmark (peer group -> sector -> S&P 900 universe).
 *
 * universe: { stocks: [{ t, n, i, s, g }] }        history: { dates, px: { t: prices[] } }
 */
export function buildModel(universe, history, M = MODEL) {
  const dates = history.dates, T = dates.length;
  const stocks = universe.stocks.filter(s => Array.isArray(history.px[s.t]) && history.px[s.t].length === T);
  const ret = new Map(), members = new Map();
  for (const s of stocks) {
    const r = logReturns(history.px[s.t]);
    ret.set(s.t, r);
    for (const key of [s.g && `peer:${s.g}`, `sector:${s.s}`, 'universe']) {
      if (!key) continue;
      if (!members.has(key)) members.set(key, []);
      members.get(key).push(r);
    }
  }
  const agg = new Map();
  for (const [key, list] of members) agg.set(key, { ...aggregate(list, T), size: list.length });

  const from = Math.max(1, T - M.BETA_WINDOW), to = T - 1;
  const fits = new Map();
  for (const s of stocks) {
    const r = ret.get(s.t), tried = [];
    let fit = null;
    for (const level of LEVELS) {
      const name = level === 'peer' ? s.g : level === 'sector' ? s.s : 'S&P 900';
      const key = level === 'peer' ? (s.g && `peer:${s.g}`) : level === 'sector' ? `sector:${s.s}` : 'universe';
      if (!key || !agg.has(key)) { tried.push({ level, name: name || '—', peers: 0, n: 0, ok: false, reason: 'no group' }); continue; }
      const a = agg.get(key), peers = a.size - 1;
      const bench = looBenchmark(a, r, M.MIN_SESSION_PEERS);
      const reg = ols(bench, r, from, to);
      const ok = peers >= M.MIN_PEERS && reg.n >= M.MIN_OBS && reg.beta === reg.beta;
      const reason = ok ? 'ok' : peers < M.MIN_PEERS ? `only ${peers} peers (min ${M.MIN_PEERS})`
        : reg.n < M.MIN_OBS ? `only ${reg.n} overlapping sessions (min ${M.MIN_OBS})` : 'degenerate';
      tried.push({ level, name, peers, n: reg.n, beta: reg.beta, alpha: reg.alpha, r2: reg.r2, ok, reason });
      if (ok && !fit) fit = { level, name, peers, ...reg, bench };
    }
    fits.set(s.t, { ...(fit || { level: null, name: null, peers: 0, n: 0, beta: NaN, alpha: NaN, r2: NaN, bench: null }), tried });
  }
  return { M, dates, T, stocks, byTicker: new Map(stocks.map(s => [s.t, s])), px: history.px, ret, agg, fits };
}

// ---- scoring ---------------------------------------------------------------

/**
 * Momentum of one stock over the last `window` sessions minus the most recent
 * `skip`, i.e. sessions (T-1-window, T-1-skip]. Returns the signal series
 * statistics or null when a required return is missing.
 *   stock:  sum of the stock's daily log returns (cumulative log return)
 *   bench:  sum of the benchmark's returns on exactly the same sessions
 *   signal: stock - beta * bench when residual, else stock
 *   sd:     sample standard deviation of the daily signal series
 */
export function momentum(r, bench, beta, T, window, skip, residual) {
  const to = T - 1 - skip, from = T - window;
  const n = to - from + 1;
  if (from < 1 || n < 2) return null;
  if (residual && !(beta === beta && bench)) return null;
  let stock = 0, bsum = 0, s2 = 0;
  const xs = new Float64Array(n);
  for (let k = from, j = 0; k <= to; k++, j++) {
    const v = r[k];
    if (v !== v) return null;
    let x = v;
    if (residual) {
      const b = bench[k];
      if (b !== b) return null;
      bsum += b; x = v - beta * b;
    }
    stock += v; xs[j] = x;
  }
  const signal = residual ? stock - beta * bsum : stock, mean = signal / n;
  for (let j = 0; j < n; j++) s2 += (xs[j] - mean) ** 2;
  return { n, stock, bench: residual ? bsum : NaN, signal, sd: Math.sqrt(s2 / (n - 1)) };
}

/** Annualized score of one window: signal x 252/N, / (sd x sqrt 252) when vol, x R^2 when r2. */
export function windowScore(m, fit, settings, M = MODEL) {
  if (!m) return null;
  let score = m.signal * M.YEAR / m.n;
  if (settings.vol) score = m.sd > 0 ? score / (m.sd * Math.sqrt(M.YEAR)) : 0;
  if (settings.r2) {
    if (!(fit.r2 === fit.r2)) return null;
    score *= fit.r2;
  }
  return score;
}

function windowsFor(settings) {
  return settings.window === 'blend' ? ['6m', '12m'] : [settings.window];
}

/**
 * Score one ticker under `settings`. Returns { score, parts } where parts maps
 * each window to its momentum statistics and annualized score. score is null
 * when any window cannot be computed (missing history, or no viable regression
 * when residual / R^2 is on). A blend is the equal-weight mean of the windows.
 */
export function scoreStock(model, t, settings) {
  const M = model.M, r = model.ret.get(t), fit = model.fits.get(t);
  if (!r || !fit) return { score: null, parts: {} };
  const skip = settings.skip ? M.SKIP : 0, parts = {};
  let total = 0, ok = true;
  for (const w of windowsFor(settings)) {
    const m = momentum(r, fit.bench, fit.beta, model.T, M.WINDOWS[w], skip, settings.residual);
    const score = windowScore(m, fit, settings, M);
    parts[w] = { ...(m || {}), score };
    if (score === null || score !== score) ok = false; else total += score;
  }
  const ws = windowsFor(settings);
  return { score: ok ? total / ws.length : null, parts };
}

// ---- cross-section ---------------------------------------------------------

/** Clip to the p and 1-p sample quantiles (nearest rank, rounded, on the sorted values). */
export function winsorize(values, p = MODEL.WINSOR) {
  if (values.length < 3) return values.slice();
  const s = values.slice().sort((a, b) => a - b);
  const lo = s[Math.round(p * (s.length - 1))], hi = s[Math.round((1 - p) * (s.length - 1))];
  return values.map(v => Math.min(Math.max(v, lo), hi));
}

/** Cross-sectional z-scores of the winsorized values (sample standard deviation). */
export function zscores(values, p = MODEL.WINSOR) {
  const w = winsorize(values, p), n = w.length;
  if (n < 2) return w.map(() => 0);
  const mean = w.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  return w.map(v => sd > 0 ? (v - mean) / sd : 0);
}

/**
 * Rank the tickers in `pool` under `settings`. Returns
 *   { rows: [{ t, score, z, pct, rank }] best first, excluded: [{ t, reason }] }
 * The order is always by the raw composite score; z, percentile (100 = top)
 * and rank are alternative representations of that one ordering.
 */
export function rankPool(model, pool, settings) {
  const rows = [], excluded = [];
  for (const t of pool) {
    const { score } = scoreStock(model, t, settings);
    if (score === null) excluded.push({ t, reason: excludeReason(model, t, settings) });
    else rows.push({ t, score });
  }
  rows.sort((a, b) => b.score - a.score);
  const z = zscores(rows.map(x => x.score), model.M.WINSOR), n = rows.length;
  rows.forEach((row, i) => {
    row.rank = i + 1;
    row.z = z[i];
    row.pct = n > 1 ? 100 * (n - 1 - i) / (n - 1) : 100;
  });
  return { rows, excluded };
}

/** Why scoreStock returned null for this ticker, in the user's terms. */
export function excludeReason(model, t, settings) {
  const fit = model.fits.get(t), r = model.ret.get(t), M = model.M, T = model.T;
  if (!r) return 'no price history';
  const need = Math.max(...windowsFor(settings).map(w => M.WINDOWS[w])), skip = settings.skip ? M.SKIP : 0;
  let first = 1;
  while (first < T && r[first] !== r[first]) first++;          // first session with a return
  if (T - first < need) return `${T - first} of ${need} sessions of history`;
  let missing = 0, latest = false;
  for (let k = T - need; k <= T - 1 - skip; k++) if (r[k] !== r[k]) { missing++; if (k === T - 1) latest = true; }
  if (missing === 1 && latest) return 'latest session missing (no quote yet)';
  if (missing) return `${missing} session${missing > 1 ? 's' : ''} missing in the last ${need}`;
  if ((settings.residual || settings.r2) && !fit.level) return 'no viable regression benchmark';
  if (settings.residual) {
    let gaps = 0;
    for (let k = T - need; k <= T - 1 - skip; k++) if (fit.bench[k] !== fit.bench[k]) gaps++;
    if (gaps) return `benchmark unavailable on ${gaps} session${gaps > 1 ? 's' : ''} (fewer than ${M.MIN_SESSION_PEERS} peers traded)`;
  }
  return 'cannot be scored';
}

/** The value shown for a row under the display mode. */
export function displayValue(row, display) {
  return display === 'z' ? row.z : display === 'pct' ? row.pct : display === 'rank' ? row.rank : row.score;
}

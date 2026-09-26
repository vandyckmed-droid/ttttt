// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, decodePrices, encodePrices, logReturns, aggregate, looBenchmark, ols,
  buildModel, momentum, windowScore, scoreStock, rankPool, winsorize, zscores, excludeReason, ols2, activeFit, rankGroups,
} from '../model.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const isNaNv = v => assert.ok(Number.isNaN(v), `${v} is not NaN`);

// Small model constants so fixtures stay hand-checkable.
const SMALL = { ...MODEL, WINDOWS: { '6m': 3, '12m': 6 }, SKIP: 1, BETA_WINDOW: 40, MIN_PEERS: 2, MIN_SESSION_PEERS: 2, MIN_OBS: 5 };

// Deterministic pseudo-random walk prices (LCG) so fixtures are reproducible.
function walk(seed, T, drift = 0, volp = 0.02) {
  let s = seed >>> 0; const out = [100];
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
  for (let k = 1; k < T; k++) out.push(out[k - 1] * Math.exp(drift + volp * (rnd() - 0.5) * Math.sqrt(12)));
  return out;
}

function fixture({ T = 30, stocks, prices }) {
  const dates = Array.from({ length: T }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`);
  return { universe: { stocks }, history: { dates, px: prices } };
}

test('logReturns: ln(P_t / P_{t-1}); NaN at k=0 and around missing prices', () => {
  const r = logReturns([100, 110, null, 121, 133.1]);
  isNaNv(r[0]);
  close(r[1], Math.log(1.1));
  isNaNv(r[2]); isNaNv(r[3]);            // missing price kills both adjacent returns
  close(r[4], Math.log(1.1));
});

test('encode/decode prices: delta cents round-trip, nulls do not break the chain', () => {
  const p = [174.49, 175.84, null, 177.23, 170.1];
  const coded = encodePrices(p);
  assert.deepEqual(coded, [17449, 135, null, 139, -713]);
  assert.deepEqual(decodePrices(coded), p);
});

test('aggregate + looBenchmark: exact (sum - self)/(count - 1) semantics and minPeers gate', () => {
  const T = 4;
  const rs = [
    Float64Array.from([NaN, 0.01, 0.02, NaN]),
    Float64Array.from([NaN, 0.03, NaN, 0.02]),
    Float64Array.from([NaN, 0.05, 0.04, 0.06]),
  ];
  const agg = aggregate(rs, T);
  assert.deepEqual(Array.from(agg.cnt), [0, 3, 2, 2]);
  close(agg.sum[1], 0.09); close(agg.sum[2], 0.06); close(agg.sum[3], 0.08);
  const b0 = looBenchmark(agg, rs[0], 1);
  close(b0[1], (0.03 + 0.05) / 2);       // others' mean
  close(b0[2], 0.04);                    // only stock 2 remains
  close(b0[3], (0.02 + 0.06) / 2);       // self missing: plain mean of the valid others
  const b0strict = looBenchmark(agg, rs[0], 2);
  isNaNv(b0strict[2]);                   // only one other name: below minPeers
  close(b0strict[1], 0.04);
  // Brute force check against the definition for every stock / session.
  for (let i = 0; i < 3; i++) {
    const b = looBenchmark(agg, rs[i], 1);
    for (let k = 1; k < T; k++) {
      const others = rs.filter((_, j) => j !== i).map(r => r[k]).filter(v => v === v);
      if (others.length) close(b[k], others.reduce((a, v) => a + v, 0) / others.length); else isNaNv(b[k]);
    }
  }
});

test('ols: exact line, textbook formulas, NaN pairs skipped, observation count', () => {
  const x = Float64Array.from([NaN, 1, 2, 3, 4, 5]), y = Float64Array.from([NaN, 3, 5, 7, 9, 11]);
  const f = ols(x, y, 1, 5);
  assert.equal(f.n, 5); close(f.beta, 2); close(f.alpha, 1); close(f.r2, 1);
  const x2 = Float64Array.from([NaN, 1, 2, NaN, 4, 5, 6]), y2 = Float64Array.from([NaN, 2, 1, 9, 3, 5, 4]);
  const g = ols(x2, y2, 1, 6);
  assert.equal(g.n, 5);                  // k=3 skipped
  // manual: pairs (1,2),(2,1),(4,3),(5,5),(6,4)
  const xs = [1, 2, 4, 5, 6], ys = [2, 1, 3, 5, 4], mx = 18 / 5, my = 15 / 5;
  const sxx = xs.reduce((a, v) => a + (v - mx) ** 2, 0), syy = ys.reduce((a, v) => a + (v - my) ** 2, 0);
  const sxy = xs.reduce((a, v, i) => a + (v - mx) * (ys[i] - my), 0);
  close(g.beta, sxy / sxx); close(g.alpha, my - (sxy / sxx) * mx); close(g.r2, sxy * sxy / (sxx * syy));
  assert.equal(ols(x, y, 1, 1).n, 1); isNaNv(ols(x, y, 1, 1).beta);
});

test('benchmark hierarchy: peer when viable, sector fallback when the group is too small, universe last', () => {
  const T = 30;
  const stocks = [
    { t: 'A', n: 'A', i: '500', s: 'Tech', g: 'Chips' }, { t: 'B', n: 'B', i: '500', s: 'Tech', g: 'Chips' },
    { t: 'C', n: 'C', i: '500', s: 'Tech', g: 'Chips' },                                     // Chips: 3 names -> 2 peers (ok at MIN_PEERS 2)
    { t: 'D', n: 'D', i: '400', s: 'Tech', g: 'Software' }, { t: 'E', n: 'E', i: '400', s: 'Tech', g: 'Software' }, // Software: 1 peer -> too small
    { t: 'F', n: 'F', i: '400', s: 'Energy', g: 'Oil' },                                      // Oil: 0 peers; Energy sector: 0 peers -> universe
  ];
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(7 + i, T)]));
  const model = buildModel(fixture({ T, stocks, prices }).universe, fixture({ T, stocks, prices }).history, SMALL);
  assert.equal(model.fits.get('A').level, 'peer');
  assert.equal(model.fits.get('A').name, 'Chips');
  assert.equal(model.fits.get('A').peers, 2);
  assert.equal(model.fits.get('D').level, 'sector');
  assert.equal(model.fits.get('D').name, 'Tech');
  assert.equal(model.fits.get('D').peers, 4);
  assert.match(model.fits.get('D').tried[0].reason, /only 1 peers/);
  assert.equal(model.fits.get('F').level, 'universe');
  assert.equal(model.fits.get('F').peers, 5);
  assert.equal(model.fits.get('F').tried[1].ok, false);
  // The regression reproduces an independent OLS against the brute-force LOO mean of the peers.
  const rA = model.ret.get('A'), rB = model.ret.get('B'), rC = model.ret.get('C');
  const bench = Float64Array.from(rA, (_, k) => k ? (rB[k] + rC[k]) / 2 : NaN);
  const ref = ols(bench, rA, 1, T - 1);
  close(model.fits.get('A').beta, ref.beta); close(model.fits.get('A').alpha, ref.alpha); close(model.fits.get('A').r2, ref.r2);
  assert.equal(model.fits.get('A').n, T - 1);
});

test('MIN_OBS: a stock with too few overlapping sessions gets no regression at any level', () => {
  const T = 30;
  const stocks = ['A', 'B', 'C', 'D', 'E'].map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Chips' }));
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(3 + i, T)]));
  prices.E = prices.E.map((p, k) => k < T - 4 ? null : p);       // E has only 3 returns
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, SMALL);
  const fE = model.fits.get('E');
  assert.equal(fE.level, null);
  assert.ok(fE.tried.every(x => !x.ok && /overlapping sessions/.test(x.reason)));
  assert.equal(model.fits.get('A').level, 'peer');                // others unaffected (E's NaNs are just skipped)
});

test('momentum: window and skip semantics, sums, benchmark alignment, residual', () => {
  const T = 10;
  const r = Float64Array.from([NaN, .01, .02, .03, .04, .05, .06, .07, .08, .09]);
  const b = Float64Array.from([NaN, .1, .1, .1, .1, .1, .2, .2, .2, .2]);
  // window 6, skip 0 -> sessions 4..9
  let m = momentum(r, b, 0.5, T, 6, 0, false);
  assert.equal(m.n, 6); close(m.stock, .04 + .05 + .06 + .07 + .08 + .09); close(m.signal, m.stock); isNaNv(m.bench);
  // window 6, skip 2 -> sessions 4..7 (the window start does not move; the recent end is cut)
  m = momentum(r, b, 0.5, T, 6, 2, false);
  assert.equal(m.n, 4); close(m.stock, .04 + .05 + .06 + .07);
  // residual: bench summed over exactly the same sessions
  m = momentum(r, b, 0.5, T, 6, 2, true);
  close(m.bench, .1 + .1 + .2 + .2); close(m.signal, (.04 + .05 + .06 + .07) - 0.5 * 0.6);
  // sd of the daily signal series x_k = r_k - beta*b_k
  const xs = [.04 - .05, .05 - .05, .06 - .1, .07 - .1], mean = xs.reduce((a, v) => a + v, 0) / 4;
  close(m.sd, Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / 3));
  // insufficient history / missing return / missing benchmark / missing beta -> null
  assert.equal(momentum(r, b, 0.5, T, 10, 0, false), null);
  const rGap = Float64Array.from(r); rGap[6] = NaN;
  assert.equal(momentum(rGap, b, 0.5, T, 6, 0, false), null);
  const bGap = Float64Array.from(b); bGap[8] = NaN;
  assert.notEqual(momentum(r, bGap, 0.5, T, 6, 2, true), null);   // gap outside the skipped window is fine
  assert.equal(momentum(r, bGap, 0.5, T, 6, 0, true), null);
  assert.equal(momentum(r, b, NaN, T, 6, 0, true), null);
  assert.notEqual(momentum(r, null, NaN, T, 6, 0, false), null);  // no benchmark needed without residual
});

test('windowScore: annualization, volatility division, R^2 multiplication compose in order', () => {
  const m = { n: 126, signal: 0.10, sd: 0.02 };
  const fit = { r2: 0.25 };
  close(windowScore(m, fit, { vol: false, r2: false }), 0.10 * 252 / 126);
  close(windowScore(m, fit, { vol: true, r2: false }), (0.10 * 2) / (0.02 * Math.sqrt(252)));
  close(windowScore(m, fit, { vol: false, r2: true }), 0.20 * 0.25);
  close(windowScore(m, fit, { vol: true, r2: true }), (0.20 / (0.02 * Math.sqrt(252))) * 0.25);
  assert.equal(windowScore(m, { r2: NaN }, { vol: false, r2: true }), null);
  assert.equal(windowScore(null, fit, {}), null);
});

test('scoreStock: blend is the equal-weight mean of the two window scores; toggles change the value as specified', () => {
  const T = 40;
  const stocks = ['A', 'B', 'C', 'D'].map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Chips' }));
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(11 + i, T, 0.001)]));
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, SMALL);
  const base = { window: 'blend', skip: false, residual: false, vol: false, r2: false };
  const s6 = scoreStock(model, 'A', { ...base, window: '6m' }).score;
  const s12 = scoreStock(model, 'A', { ...base, window: '12m' }).score;
  close(scoreStock(model, 'A', base).score, (s6 + s12) / 2);
  // 12m raw = sum of the last 6 returns x 252/6
  const r = model.ret.get('A');
  let sum = 0; for (let k = T - 6; k <= T - 1; k++) sum += r[k];
  close(s12, sum * 252 / 6);
  // skip drops the most recent SKIP sessions from the same window
  let sumSkip = 0; for (let k = T - 6; k <= T - 2; k++) sumSkip += r[k];
  close(scoreStock(model, 'A', { ...base, window: '12m', skip: true }).score, sumSkip * 252 / 5);
  // residual removes beta x benchmark momentum over the same sessions
  const fit = model.fits.get('A');
  let bsum = 0; for (let k = T - 6; k <= T - 1; k++) bsum += fit.bench[k];
  close(scoreStock(model, 'A', { ...base, window: '12m', residual: true }).score, (sum - fit.beta * bsum) * 252 / 6);
  // R^2 multiplies by the active regression's R^2
  close(scoreStock(model, 'A', { ...base, window: '12m', r2: true }).score, s12 * fit.r2);
  // parts expose the per-window statistics
  const parts = scoreStock(model, 'A', base).parts;
  assert.equal(parts['6m'].n, 3); assert.equal(parts['12m'].n, 6);
});

test('rankPool: order by score, rank / percentile / z are representations of the same order; exclusions explained', () => {
  const T = 40;
  const stocks = ['A', 'B', 'C', 'D', 'E'].map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Chips' }));
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(21 + i, T, (i - 2) * 0.01)]));
  prices.E = prices.E.map((p, k) => k === T - 2 ? null : p);      // E misses a recent session
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, SMALL);
  const settings = { window: '12m', skip: false, residual: false, vol: false, r2: false };
  const { rows, excluded } = rankPool(model, ['A', 'B', 'C', 'D', 'E'], settings);
  assert.deepEqual(excluded.map(x => x.t), ['E']);
  assert.equal(excludeReason(model, 'E', settings), '2 sessions missing in the last 6');   // a missing price voids both adjacent returns
  assert.equal(excludeReason(model, 'E', { ...settings, skip: true }), '1 session missing in the last 6');  // the latest return is skipped
  const pricesF = { ...prices, F: walk(5, T).map((p, k) => k === T - 1 ? null : p) };   // no quote for the latest session
  const mF = buildModel({ stocks: [...stocks, { t: 'F', n: 'F', i: '500', s: 'Tech', g: 'Chips' }] }, fixture({ T, stocks, prices: pricesF }).history, SMALL);
  assert.equal(excludeReason(mF, 'F', settings), 'latest session missing (no quote yet)');
  assert.notEqual(scoreStock(mF, 'F', { ...settings, skip: true }).score, null);       // with Skip the missing latest session does not matter
  assert.equal(rows.length, 4);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(rows.map(r => r.pct), [100, 200 / 3, 100 / 3, 0]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].z >= rows[i].z);
  // z-scores come from the winsorized scores (n=4 -> no clipping at 1%) with sample sd
  const scores = rows.map(r => r.score), mean = scores.reduce((a, v) => a + v, 0) / 4;
  const sd = Math.sqrt(scores.reduce((a, v) => a + (v - mean) ** 2, 0) / 3);
  rows.forEach((r, i) => close(r.z, (scores[i] - mean) / sd));
  // residual on: a stock with no viable benchmark is excluded with a clear reason
  // Z has 7 returns: enough for the 6-session window, too few for a regression at MIN_OBS 10.
  const lonely = [{ t: 'Z', n: 'Z', i: '400', s: 'Solo', g: 'OnlyMe' }];
  const zPrices = walk(99, T).map((p, k) => k < T - 8 ? null : p);
  const m2 = buildModel({ stocks: [...stocks, ...lonely] },
    fixture({ T, stocks: [...stocks, ...lonely], prices: { ...prices, Z: zPrices } }).history, { ...SMALL, MIN_OBS: 10 });
  assert.equal(m2.fits.get('Z').level, null);
  assert.equal(m2.fits.get('A').level, 'peer');
  assert.notEqual(scoreStock(m2, 'Z', settings).score, null);          // plain momentum still works for Z
  const res = rankPool(m2, ['A', 'Z'], { ...settings, residual: true });
  assert.deepEqual(res.excluded, [{ t: 'Z', reason: 'no viable regression benchmark' }]);
});

test('winsorize / zscores: clip at the 1st and 99th percentile before standardizing', () => {
  const v = Array.from({ length: 101 }, (_, i) => i);
  v[100] = 1e6;                                     // one wild outlier
  const w = winsorize(v, 0.01);
  assert.equal(Math.max(...w), 99); assert.equal(Math.min(...w), 1);
  const z = zscores(v, 0.01);
  assert.ok(Math.abs(z[100] - z[99]) < 1e-9);       // the outlier is clipped onto the 99th percentile
  const z2 = zscores([1, 2]); close(z2[0], -Math.SQRT1_2); close(z2[1], Math.SQRT1_2);
  assert.deepEqual(zscores([5]), [0]);
});

test('efficient LOO equals brute force on a larger random fixture (universe level)', () => {
  const T = 60, N = 25;
  const stocks = Array.from({ length: N }, (_, i) => ({ t: `S${i}`, n: `S${i}`, i: '500', s: 'X', g: 'G' }));
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(100 + i, T)]));
  for (let i = 0; i < N; i += 7) prices[`S${i}`][30 + i % 5] = null;   // scatter some gaps
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, { ...SMALL, MIN_PEERS: 3, MIN_SESSION_PEERS: 3 });
  for (const s of stocks.slice(0, 6)) {
    const mine = model.ret.get(s.t), b = looBenchmark(model.agg.get('universe'), mine, 3);
    for (let k = 1; k < T; k++) {
      const others = stocks.filter(o => o.t !== s.t).map(o => model.ret.get(o.t)[k]).filter(v => v === v);
      if (others.length >= 3) close(b[k], others.reduce((a, v) => a + v, 0) / others.length); else isNaNv(b[k]);
    }
  }
});

test('session gate: one missing print in a 9-name group keeps the benchmark (MIN_SESSION_PEERS < MIN_PEERS)', () => {
  const T = 30, names = 'ABCDEFGHI'.split('');
  const stocks = names.map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Nine' }));
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(40 + i, T)]));
  prices.I[T - 3] = null;                                    // I misses one recent print
  const M = { ...MODEL, WINDOWS: { '6m': 3, '12m': 6 }, SKIP: 1, BETA_WINDOW: 20, MIN_OBS: 5, MIN_PEERS: 8, MIN_SESSION_PEERS: 4 };
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, M);
  const fA = model.fits.get('A');
  assert.equal(fA.level, 'peer'); assert.equal(fA.peers, 8);
  assert.ok(fA.bench[T - 3] === fA.bench[T - 3], 'benchmark still defined with 7 others trading');
  const { rows, excluded } = rankPool(model, names, { window: '12m', skip: false, residual: true, vol: false, r2: false });
  assert.equal(rows.length, 8);                              // only I itself (missing return) is excluded
  assert.deepEqual(excluded.map(x => x.t), ['I']);
  // With the strict gate the whole group would have lost the benchmark on that session.
  const strict = buildModel({ stocks }, fixture({ T, stocks, prices }).history, { ...M, MIN_SESSION_PEERS: 8 });
  assert.ok(Number.isNaN(strict.fits.get('A').bench[T - 3]));
  assert.equal(rankPool(strict, names, { window: '12m', skip: false, residual: true, vol: false, r2: false }).rows.length, 0);
  assert.match(excludeReason(strict, 'A', { window: '12m', skip: false, residual: true, vol: false, r2: false }), /benchmark unavailable on 2 sessions/);
});

test('ols2: exact plane, textbook two-regressor formulas, residual sd; collinear factors are rejected', () => {
  const x1 = Float64Array.from([NaN, 1, 2, 3, 4, 5, 6]), x2 = Float64Array.from([NaN, 2, 1, 4, 3, 6, 5]);
  const y = Float64Array.from(x1, (v, k) => k ? 1 + 2 * v - 3 * x2[k] : NaN);
  const f = ols2(x1, x2, y, 1, 6);
  assert.equal(f.n, 6); close(f.beta[0], 2); close(f.beta[1], -3); close(f.alpha, 1); close(f.r2, 1); close(f.resid, 0);
  // noisy case against an independent least-squares solve (normal equations with intercept)
  const yn = Float64Array.from([NaN, 1.2, -0.3, 2.9, 0.4, 3.1, 1.8]);
  const g = ols2(x1, x2, yn, 1, 6);
  const X = [1, 2, 3, 4, 5, 6].map((v, i) => [1, v, x2[i + 1]]), Y = Array.from(yn.slice(1));
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], XtY = [0, 0, 0];
  for (let i = 0; i < 6; i++) for (let a = 0; a < 3; a++) { XtY[a] += X[i][a] * Y[i]; for (let b = 0; b < 3; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const solve = (A, B) => { const M = A.map((r, i) => [...r, B[i]]); for (let c = 0; c < 3; c++) { const p = M[c][c]; for (let j = c; j < 4; j++) M[c][j] /= p; for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j < 4; j++) M[r][j] -= f * M[c][j]; } } return M.map(r => r[3]); };
  const [a, b1, b2] = solve(XtX, XtY);
  close(g.alpha, a); close(g.beta[0], b1); close(g.beta[1], b2);
  const fitted = X.map(r => a + b1 * r[1] + b2 * r[2]), my = Y.reduce((s, v) => s + v, 0) / 6;
  const sse = Y.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0), sst = Y.reduce((s, v) => s + (v - my) ** 2, 0);
  close(g.r2, 1 - sse / sst); close(g.resid, Math.sqrt(sse / 3));
  const h = ols2(x1, Float64Array.from(x1, v => 2 * v), yn, 1, 6);
  assert.ok(Number.isNaN(h.beta[0]) && Number.isNaN(h.r2), 'collinear regressors are not identifiable');
  assert.ok(ols(x1, yn, 1, 6).resid > 0, 'one-factor fit reports a residual sd');
});

test('two-factor benchmark: peer + market fit, residual momentum removes both, falls back cleanly', () => {
  const T = 40;
  const stocks = [...'ABCDE'.split('').map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Chips' })), ...'FGHIJ'.split('').map(t => ({ t, n: t, i: '400', s: 'Energy', g: 'Oil' }))];
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(60 + i, T, (i % 3) * 0.002)]));
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, SMALL);
  const one = model.fits.get('A'), two = one.two;
  assert.equal(two.factors, 2); assert.equal(two.level, 'peer'); assert.equal(two.name, 'Chips');
  // reproduces ols2 on the same series
  const ref = ols2(one.bench, two.mkt, model.ret.get('A'), 1, T - 1);
  close(two.beta[0], ref.beta[0]); close(two.beta[1], ref.beta[1]); close(two.r2, ref.r2); assert.equal(two.n, ref.n);
  // the market factor is the S&P 900 leave-one-out benchmark
  const rA = model.ret.get('A');
  const others = stocks.filter(s => s.t !== 'A').map(s => model.ret.get(s.t));
  for (let k = 1; k < T; k++) close(two.mkt[k], others.reduce((s, r) => s + r[k], 0) / others.length);
  // settings switch between the fits and the residual uses both betas over the same sessions
  const base = { window: '12m', skip: false, residual: true, vol: false, r2: false };
  assert.equal(activeFit(model, 'A', { ...base, factors: 'one' }), one);
  assert.equal(activeFit(model, 'A', { ...base, factors: 'two' }), two);
  let stock = 0, bsum = 0, msum = 0;
  for (let k = T - 6; k <= T - 1; k++) { stock += rA[k]; bsum += one.bench[k]; msum += two.mkt[k]; }
  close(scoreStock(model, 'A', { ...base, factors: 'two' }).score, (stock - two.beta[0] * bsum - two.beta[1] * msum) * 252 / 6);
  close(scoreStock(model, 'A', { ...base, factors: 'one' }).score, (stock - one.beta * bsum) * 252 / 6);
  // R^2 multiplier uses the active regression's R^2
  const raw = scoreStock(model, 'A', { ...base, residual: false, factors: 'two' }).score;
  close(scoreStock(model, 'A', { ...base, residual: false, r2: true, factors: 'two' }).score, raw * two.r2);
  // a name whose only viable benchmark is the universe keeps a one-factor fit under 'two'
  const lonely = [{ t: 'Z', n: 'Z', i: '400', s: 'Solo', g: 'Me' }];
  const m2 = buildModel({ stocks: [...stocks, ...lonely] }, fixture({ T, stocks: [...stocks, ...lonely], prices: { ...prices, Z: walk(99, T) } }).history, SMALL);
  assert.equal(m2.fits.get('Z').level, 'universe'); assert.equal(m2.fits.get('Z').two.factors, 1); assert.equal(m2.fits.get('Z').two.level, 'universe');
});

test('rankGroups: equal-weight mean of member scores, ordered, with the same representations as stock rows', () => {
  const T = 40;
  const stocks = [...'ABC'.split('').map(t => ({ t, n: t, i: '500', s: 'Tech', g: 'Chips' })), ...'DEF'.split('').map(t => ({ t, n: t, i: '400', s: 'Tech', g: 'Soft' })), { t: 'G', n: 'G', i: '400', s: 'X', g: null }];
  const prices = Object.fromEntries(stocks.map((s, i) => [s.t, walk(70 + i, T, (i - 3) * 0.003)]));
  const model = buildModel({ stocks }, fixture({ T, stocks, prices }).history, SMALL);
  const settings = { window: '12m', skip: false, residual: false, vol: false, r2: false, factors: 'one' };
  const { rows } = rankPool(model, stocks.map(s => s.t), settings);
  const groups = rankGroups(model, rows);
  assert.deepEqual(groups.map(g => g.t).sort(), ['Chips', 'Soft']);          // G has no group
  const by = Object.fromEntries(rows.map(r => [r.t, r.score]));
  const chips = groups.find(g => g.t === 'Chips'), soft = groups.find(g => g.t === 'Soft');
  close(chips.score, (by.A + by.B + by.C) / 3); close(soft.score, (by.D + by.E + by.F) / 3);
  assert.equal(chips.n, 3); assert.equal(chips.sector, 'Tech');
  assert.equal(chips.top, ['A', 'B', 'C'].reduce((a, b) => by[a] >= by[b] ? a : b));
  assert.ok(groups[0].score >= groups[1].score && groups[0].rank === 1 && groups[1].rank === 2);
  assert.deepEqual(groups.map(g => g.pct), [100, 0]);
  close(groups[0].z, -groups[1].z);
});

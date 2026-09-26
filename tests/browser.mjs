// End-to-end drive of the page in headless Chromium with FMP mocked.
//   python3 -m http.server 8000 &  (from the repo root)
//   NODE_PATH=/path/to/node_modules node tests/browser.mjs [http://127.0.0.1:8000/] [shots-dir]
// Exits non-zero on any failed check. Screenshots go to shots-dir when given.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { decodePrices } from '../model.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8000/';
const SHOTS = process.argv[3] || '';
const seed = JSON.parse(readFileSync(new URL('../data/history.json', import.meta.url)));
const universe = JSON.parse(readFileSync(new URL('../data/universe.json', import.meta.url)));
const seedPx = Object.fromEntries(Object.entries(seed.px).map(([t, c]) => [t, decodePrices(c)]));
const seedIdx = new Map(seed.dates.map((d, i) => [d, i]));
const lastClose = Object.fromEntries(Object.entries(seedPx).map(([t, p]) => [t, p[p.length - 1]]));
const L = seed.dates[seed.dates.length - 1];
const QB = Math.ceil(universe.stocks.length / 100);   // quote batches per refresh
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const afterToast = async (page, action, extra = '', timeout = 20000) => {
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });   // clear any previous toast
  await action();
  await page.waitForSelector(`.toast:not([hidden])${extra}`, { timeout });
  return page.textContent('#toast');
};
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve();
const nyTs = (date, hh, mm) => Math.floor(new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00`).getTime() / 1000);

// Behind a TLS-intercepting proxy (e.g. a sandbox) Chromium may not reach a remote BASE: with
// PW_CURL_TRANSPORT=1 the page's requests to BASE are carried by curl (which trusts the proxy)
// and fulfilled verbatim, so the browser still executes exactly what the server sends.
const browser = await chromium.launch();
const { execFileSync } = await import('node:child_process');
async function curlTransport(page) {
  if (!process.env.PW_CURL_TRANSPORT || BASE.startsWith('http://127.0.0.1') || BASE.startsWith('http://localhost')) return;
  await page.route(new URL(BASE).origin + '/**', route => {
    const out = execFileSync('curl', ['-sS', '-w', '\n%{http_code}\n%{content_type}', route.request().url()], { maxBuffer: 64e6 });
    const txt = out.toString('latin1'), j = txt.lastIndexOf('\n'), i = txt.lastIndexOf('\n', j - 1);
    route.fulfill({ status: +txt.slice(i + 1, j), contentType: txt.slice(j + 1) || 'application/octet-stream', body: out.subarray(0, i) });
  });
}

async function newPage(viewport = { width: 390, height: 844 }, mobile = true) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await curlTransport(page);
  const log = { errors: [], fmp: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) log.errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => log.errors.push('pageerror: ' + e.message));
  page.on('request', r => { if (r.url().includes('financialmodelingprep')) log.fmp.push(r.url()); });
  return { ctx, page, log };
}
async function load(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.list:not(.skeleton) .row');
}
const rows = page => page.locator('.list .row').evaluateAll(els => els.map(e => ({ t: e.dataset.t, rk: e.querySelector('.rk').textContent, v: e.querySelector('.sc').textContent, sub: e.querySelector('.sub').textContent })));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Mock FMP for a scenario: quote session date/time, optional history gap dates, optional error mode. */
function mockFmp(page, { date = L, hh = 16, mm = 0, sessions = [], splits = {}, divs = {}, exDate = '9999', quoteBump = {}, mode = 'ok', keySeen }) {
  const calls = { quote: 0, history: 0, historyFrom: {}, hist429: 0 };
  return page.route('https://financialmodelingprep.com/**', route => {
    const u = new URL(route.request().url());
    if (keySeen) keySeen.push(u.searchParams.get('apikey'));
    if (mode === '401') return route.fulfill({ status: 401, body: '{"Error Message":"Invalid API KEY"}' });
    if (mode === '401hist' && u.pathname.endsWith('/dividend-adjusted') && u.searchParams.get('symbol') === 'A') { calls.history++; return route.fulfill({ status: 401, body: '{}' }); }
    if (mode === 'abort') return route.abort('failed');
    if (mode === '429once' && calls.hist429 === 0) { calls.hist429++; return route.fulfill({ status: 429, body: 'Limit Reach' }); }
    if (u.pathname.endsWith('/batch-quote')) {
      calls.quote++;
      const syms = u.searchParams.get('symbols').split(',');
      return route.fulfill({ json: syms.map(s => ({ symbol: s, price: +((lastClose[s] || 50) * (splits[s] || (quoteBump[s] || 1.01))).toFixed(2), previousClose: +((lastClose[s] || 50) * (splits[s] || 1)).toFixed(2), timestamp: nyTs(date, hh, mm) })) });
    }
    // Daily history: 'light' (calendar references) or 'dividend-adjusted' (per-name series). A
    // name in `divs` went ex-dividend on `exDate`: every adjusted value before that date is scaled
    // down by its factor. Sessions after the seed trade at 1.01 x the last close, like the quotes.
    if (u.pathname.endsWith('/historical-price-eod/light') || u.pathname.endsWith('/dividend-adjusted')) {
      calls.history++;
      const adj = u.pathname.endsWith('/dividend-adjusted');
      const s = u.searchParams.get('symbol'), from = u.searchParams.get('from'), to = u.searchParams.get('to') || '9999';
      calls.historyFrom[s] = from;
      const all = [...seed.dates, ...sessions].filter(d => d >= from && d <= to);
      // Seed sessions return the seed's own (adjusted) value; later sessions trade at 1.01 x the last close, like the quotes.
      const value = d => { const v = seedIdx.has(d) && seedPx[s] ? seedPx[s][seedIdx.get(d)] : (lastClose[s] || 50) * 1.01;
        return v === null ? 0 : +(v * (splits[s] || 1) * (adj && d < exDate ? (divs[s] || 1) : 1)).toFixed(2); };
      return route.fulfill({ json: all.map(d => adj ? { symbol: s, date: d, adjClose: value(d), volume: 1 } : { symbol: s, date: d, price: value(d), volume: 1 }).filter(r => (r.adjClose ?? r.price) > 0).reverse() });
    }
    return route.fulfill({ status: 404, body: '[]' });
  }).then(() => calls);
}

// ---- 1. ranking screen, settings, displays ----------------------------------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  check(log.fmp.length === 0, 'no FMP request on load');
  check(await noOverflow(page), 'no horizontal overflow at 390px');
  let r = await rows(page);
  check(r.length > 850, `ranked rows: ${r.length}`);
  check(/^[+−]\d+\.\d%$/.test(r[0].v), `raw value format: ${r[0].v}`);
  check((await page.textContent('#status-text')).includes('not refreshed'), 'status says not refreshed');
  await shot(page, 'rank-390');
  const before = r.map(x => x.t).join(',');

  await page.click('#btn-settings');
  await page.waitForSelector('#sheet-settings.on');
  await shot(page, 'settings-390');
  await page.click('[data-flag="residual"]');
  r = await rows(page);
  check(r.map(x => x.t).join(',') !== before, 'residual re-ranks immediately');
  check((await page.locator('.mv').count()) > 0, 'rank-move badges shown after a settings change');
  check((await page.textContent('#chips')).includes('Residual'), 'chip shows Residual');
  await page.click('[data-flag="vol"]');
  r = await rows(page);
  check(/^[+−]\d+\.\d\d$/.test(r[0].v), `vol-adjusted value is a ratio: ${r[0].v}`);
  await page.click('[data-flag="r2"]');
  check((await page.textContent('#chips')).includes('R²'), 'chip shows R²');
  await page.click('[data-flag="skip"]');
  check(!(await page.textContent('#chips')).includes('Skip'), 'skip off removes chip');
  await page.click('[data-window="6m"]');
  check((await page.textContent('#chips')).startsWith('6M'), 'window chip 6M');
  const rawOrder = (await rows(page)).map(x => x.t).join(',');
  for (const [d, re] of [['z', /^[+−]\d\.\d\d$/], ['pct', /^\d+%$/], ['rank', /^#\d+$/]]) {
    await page.click(`[data-display="${d}"]`);
    const rr = await rows(page);
    check(re.test(rr[0].v), `display ${d}: ${rr[0].v}`);
    check(rr.map(x => x.t).join(',') === rawOrder, `display ${d} keeps the order`);
  }
  await page.click('[data-display="pct"]');
  const rp = await rows(page);
  check(rp[0].v === '100%' && rp[rp.length - 1].v === '0%', 'percentile spans 100% .. 0%');
  await page.click('#reset');
  check((await page.textContent('#chips')).startsWith('6M+12M') && (await page.textContent('#chips')).includes('Skip 21'), 'reset restores defaults');
  await page.click('#sheet-settings [data-close]');
  await page.waitForTimeout(350);
  // settings persist across reload
  await page.click('#btn-settings'); await page.click('[data-flag="residual"]'); await page.click('#sheet-settings [data-close]');
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.list:not(.skeleton) .row');
  check((await page.textContent('#chips')).includes('Residual'), 'settings persist across reload');
  check(log.fmp.length === 0, 'still no FMP request after reload');

  // scope + search
  await page.click('[data-scope="400"]');
  r = await rows(page);
  check(r.length > 350 && r.length < 402, `S&P 400 scope ranks ${r.length}`);
  check(r[0].rk === '1', 'ranks restart at 1 in the filtered pool');
  await page.click('[data-scope="all"]');
  await page.fill('#search', 'micro');
  r = await rows(page);
  check(r.length > 0 && r.length < 20 && r.some(x => x.t === 'MU'), `search "micro" -> ${r.map(x => x.t).join(' ')}`);
  await page.fill('#search', 'FDXF');
  r = await rows(page);
  check(r.length === 1 && r[0].v === '—' && /sessions of history/.test(r[0].sub), `excluded name shows reason: ${r[0] && r[0].sub}`);
  await page.fill('#search', '');
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 2. ticker detail -----------------------------------------------------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  await page.click('.list .row[data-t="MU"]');
  await page.waitForSelector('#detail.on');
  check((await page.textContent('#d-ticker')) === 'MU', 'detail opens MU');
  check((await page.evaluate(() => location.hash)) === '#MU', 'hash routes to ticker');
  check(/\$\d/.test(await page.textContent('.d-price')), 'price shown');
  check((await page.locator('#chart path.ln').count()) === 1, 'chart drawn');
  await shot(page, 'detail-mu');
  for (const h of ['1M', '3Y']) {
    await page.click(`[data-hz="${h}"]`);
    check((await page.locator(`[data-hz="${h}"]`).getAttribute('aria-pressed')) === 'true' && /–/.test(await page.textContent('#hzl')), `horizon ${h}`);
  }
  await page.click('[data-overlay="bench"]');
  check((await page.locator('#chart path.bl').count()) === 1, 'benchmark overlay drawn');
  await shot(page, 'detail-mu-bench');
  await page.click('[data-overlay="resid"]');
  check((await page.locator('#chart path.rl').count()) === 1, 'residual overlay drawn');
  await shot(page, 'detail-mu-resid');
  check((await page.locator('#scatter svg circle').count()) > 700, 'beta scatter drawn with the regression window');
  check(/Idiosyncratic volatility/.test(await page.textContent('.page-body')), 'idiosyncratic volatility shown');
  await page.hover('#chart svg', { position: { x: 200, y: 100 } });
  check(!(await page.locator('#tip').isHidden()), 'hover readout');
  const reg = await page.textContent('.page-body');
  check(/Peer group benchmark/.test(reg) && /Semiconductors/.test(reg) && /Beta/.test(reg) && /R²/.test(reg) && /Observations/.test(reg), 'regression card: peer benchmark, beta, R², observations');
  check(/#\d+ of \d+/.test(reg) && /percentile/.test(reg), 'rank and percentile shown');
  // two-factor regression
  await page.click('#d-back'); await page.waitForTimeout(350);
  await page.click('#btn-settings'); await page.click('[data-factors="two"]'); await page.click('[data-flag="residual"]'); await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(300);
  check((await page.textContent('#chips')).includes('2-factor'), 'chip shows 2-factor');
  await page.click('.list .row[data-t="MU"]'); await page.waitForSelector('#detail.on');
  const two = await page.textContent('.page-body');
  check(/\+ S&P 900/.test(two) && /Beta · Semiconductors/.test(two) && /Beta · S&P 900/.test(two) && /market /.test(two), 'two-factor detail shows both betas and the market term');
  await shot(page, 'detail-mu-2f');
  await page.click('#d-back'); await page.waitForTimeout(350);
  await page.click('#btn-settings'); await page.click('#reset'); await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(300);
  // sector fallback diagnostics
  await page.fill('#search', 'VZ'); await page.click('.list .row[data-t="VZ"]'); await page.waitForSelector('#detail.on');
  const vz = await page.textContent('.page-body');
  check(/Sector benchmark · fallback/.test(vz) && /Peer group Telecom not used: only 5 other names/.test(vz), 'VZ falls back to the sector benchmark with the reason');
  await shot(page, 'detail-vz');
  // no viable regression
  await page.click('#d-back'); await page.waitForTimeout(350);
  await page.fill('#search', 'FDXF'); await page.click('.list .row[data-t="FDXF"]'); await page.waitForSelector('#detail.on');
  const fx = await page.textContent('.page-body');
  check(/No viable benchmark/.test(fx) && /Not ranked/.test(fx), 'FDXF: no benchmark and not ranked, explained');
  // peer-group filter from the company card
  await page.click('#d-back'); await page.waitForTimeout(350);
  await page.fill('#search', ''); await page.click('.list .row[data-t="NVDA"]'); await page.waitForSelector('#detail.on');
  await page.click('#peers-link'); await page.waitForTimeout(350);
  const r = await rows(page);
  check(r.length > 25 && r.length < 40 && !(await page.locator('#filter').isHidden()), `peer filter shows ${r.length} semiconductor names`);
  await shot(page, 'peers-filter');
  await page.click('#filter-clear');
  check((await rows(page)).length > 850, 'filter cleared');
  // browser back closes the detail
  await page.click('.list .row[data-t="AMD"]'); await page.waitForSelector('#detail.on');
  await page.goBack(); await page.waitForTimeout(350);
  check(!(await page.locator('#detail').evaluate(e => e.classList.contains('on'))), 'browser back closes detail');
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  check(log.fmp.length === 0, 'no FMP request while browsing details');
  await ctx.close();
}

// ---- 3. refresh: no key, key entry, same-session refresh, persistence ---------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  await page.click('#btn-refresh');
  await page.waitForSelector('#sheet-data.on');
  check(await page.locator('#do-refresh').isDisabled(), 'refresh disabled without a key');
  check(/Add your FMP key/.test(await page.textContent('#refresh-note')), 'no-key message');
  await shot(page, 'data-nokey');
  check(log.fmp.length === 0, 'no FMP request without a key');
  await page.click('#key-save');
  check(/Paste a key/.test(await page.textContent('#key-note')), 'empty key rejected');
  const keySeen = [];
  const calls = await mockFmp(page, { keySeen });
  await page.fill('#key', 'test-key-1234'); await page.click('#key-save');
  await page.waitForFunction(() => /accepted/.test(document.getElementById('key-note').textContent), null, { timeout: 10000 });
  check(calls.quote === 1, 'saving a key tests it with exactly one quote request');
  check(!(await page.locator('#do-refresh').isDisabled()), 'refresh enabled after saving a key');
  check((await page.textContent('#data-facts')).includes('test…'), 'key shown masked');
  calls.quote = 0;
  await page.click('#do-refresh');
  await page.waitForFunction(() => /^Updated/.test(document.getElementById('refresh-note').textContent), null, { timeout: 15000 });
  const toast = await page.textContent('#refresh-note');
  check(toast.includes(`${QB} requests`), `same-session refresh result: ${toast}`);
  check(await page.locator('#toast').isHidden(), 'no toast while the data sheet shows the result');
  check(await page.locator('#refresh-progress').isHidden(), 'progress bar hidden after completion');
  check(calls.quote === QB && calls.history === 0, `requests: ${calls.quote} quote batches, ${calls.history} history`);
  check(keySeen.every(k => k === 'test-key-1234'), 'key sent only to FMP requests');
  check(/updated just now/.test(await page.textContent('#status-text')), 'status shows updated');
  await shot(page, 'data-refreshed');
  await page.click('#sheet-data [data-close]'); await page.waitForTimeout(300);
  const mu = await page.locator('.list .row[data-t="MU"] .sc').textContent();
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.list:not(.skeleton) .row');
  check(/updated/.test(await page.textContent('#status-text')), 'refreshed state persists across reload');
  check((await page.locator('.list .row[data-t="MU"] .sc').textContent()) === mu, 'persisted prices reproduce the ranking');
  check(log.fmp.length === QB + 1, `total FMP requests in this session: ${log.fmp.length} = 1 key test + ${QB} quote batches (none on reload)`);
  await page.click('#status'); await page.click('#key-clear');
  check(await page.locator('#do-refresh').isDisabled(), 'clearing the key disables refresh');
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 4. refresh: next session (append), split detection, multi-session gap ----------------
{
  const { ctx, page, log } = await newPage();
  await page.addInitScript(() => localStorage.setItem('fmpKey', JSON.stringify('k')));
  await load(page);
  const T0 = await page.evaluate(() => document.querySelectorAll('.list .row').length);
  // MU's intraday quote sits 2% above the close FMP will later report for that session.
  const calls = await mockFmp(page, { date: '2026-09-28', hh: 10, mm: 30, sessions: ['2026-09-28'], splits: { AAPL: 0.25 }, quoteBump: { MU: 1.03 } });
  const toast = await afterToast(page, () => page.click('#btn-refresh'));
  check(/Sep 28 10:30 AM/.test(toast) && toast.includes(`${QB + 3} requests`), `next-session live refresh: ${toast}`);
  check(calls.quote === QB && calls.history === 3 && calls.historyFrom.AAPL === seed.dates[0], `2 reference calls + 1 full re-download for the split (${JSON.stringify(calls.historyFrom)})`);
  check(/Sep 28 live/.test(await page.textContent('#status-text')), 'status marks intraday prices');
  const readStored = () => page.evaluate(() => new Promise(res => { const q = indexedDB.open('momentum', 1); q.onsuccess = () => { const r = q.result.transaction('kv').objectStore('kv').get('history'); r.onsuccess = () => res(r.result); }; }));
  let stored = await readStored();
  const muIntraday = decodePrices(stored.px.MU).at(-1);
  check(stored.dates.at(-1) === '2026-09-28' && Math.abs(muIntraday - lastClose.MU * 1.03) < 0.011, `intraday quote stored for Sep 28 (${muIntraday})`);
  await page.unroute('https://financialmodelingprep.com/**');
  // The next session's refresh replaces that intraday snapshot with the official close (previousClose here).
  const callsB = await mockFmp(page, { date: '2026-09-29', hh: 16, mm: 0, sessions: ['2026-09-28', '2026-09-29'], splits: { AAPL: 0.25 } });
  const toastB = await afterToast(page, () => page.click('#btn-refresh'));
  stored = await readStored();
  const mu = decodePrices(stored.px.MU);
  check(/Sep 29 close/.test(toastB) && callsB.history === 2 && stored.dates.at(-1) === '2026-09-29', `following refresh appends Sep 29 with only the reference calls: ${toastB}`);
  check(Math.abs(mu.at(-2) - lastClose.MU) < 0.011, `Sep 28 corrected from intraday ${muIntraday} to the close ${mu.at(-2)}`);
  await page.unroute('https://financialmodelingprep.com/**');
  // a 3-session gap: per-name history for every ticker
  const vzBefore = decodePrices((await readStored()).px.VZ);
  const calls2 = await mockFmp(page, { date: '2026-10-02', hh: 16, mm: 0, sessions: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], splits: { AAPL: 0.25 }, divs: { VZ: 0.98 }, exDate: '2026-09-29' });   // ex on a session that quotes-only refreshes appended
  const toast2 = await afterToast(page, () => page.click('#btn-refresh'), '', 60000);
  check(/Oct 2 close/.test(toast2), `gap refresh: ${toast2}`);
  const vzAfter = decodePrices((await readStored()).px.VZ);
  check(Math.abs(vzAfter[0] / vzBefore[0] - 0.98) < 1e-3 && Math.abs(vzAfter[100] / vzBefore[100] - 0.98) < 1e-3, `dividend reconciliation rescales VZ's earlier history by 0.98 (${vzBefore[0]} -> ${vzAfter[0]})`);
  check(Math.abs(vzAfter.at(-1) - lastClose.VZ * 1.01) < 0.011, 'latest VZ value is still the quote');
  const st2 = await readStored(), mu2 = decodePrices(st2.px.MU);
  check(Math.abs(mu2[0] - decodePrices(seed.px.MU)[0]) < 1e-9, 'a name without a dividend is not rescaled (a quote/close mismatch is not a dividend)');
  check(Math.abs(mu2[st2.dates.indexOf('2026-09-28')] - lastClose.MU * 1.01) < 0.011, 'the mismatched intraday quote for Sep 28 is replaced by the adjusted close');
  const meta = await page.evaluate(() => new Promise(res => { const q = indexedDB.open('momentum', 1); q.onsuccess = () => { const r = q.result.transaction('kv').objectStore('kv').get('meta'); r.onsuccess = () => res(r.result); }; }));
  check(meta.reconciled === '2026-10-02' && meta.pending.length === 0, `full pass recorded: adjusted through ${meta.reconciled}`);
  check(calls2.quote === QB && calls2.history === universe.stocks.length + 2, `gap refresh requests: ${calls2.quote} + ${calls2.history} (2 references + ${universe.stocks.length} names)`);
  check((await readStored()).dates.slice(-4).join(',') === '2026-09-29,2026-09-30,2026-10-01,2026-10-02', 'gap sessions inserted in order');
  check(Math.abs((await page.evaluate(() => document.querySelectorAll('.list .row').length)) - T0) < 10, 'ranking still covers the universe');
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 5. refresh failures ------------------------------------------------------------------
{
  const { ctx, page, log } = await newPage();
  await page.addInitScript(() => localStorage.setItem('fmpKey', JSON.stringify('bad')));
  await load(page);
  await mockFmp(page, { mode: '401' });
  await page.click('#btn-refresh');
  await page.waitForSelector('#sheet-data.on');
  check(/rejected/.test(await page.textContent('#key-note')) && /rejected the API key/.test(await page.textContent('#refresh-note')), 'invalid key: data sheet opens with the error');
  await shot(page, 'refresh-badkey');
  check(/not refreshed/.test(await page.textContent('#status-text')), 'failed refresh leaves data untouched');
  await page.click('#sheet-data [data-close]');
  await page.unroute('https://financialmodelingprep.com/**');
  await mockFmp(page, { mode: 'abort' });
  check(/Network error/.test(await afterToast(page, () => page.click('#btn-refresh'))), 'network failure reported');
  await page.unroute('https://financialmodelingprep.com/**');
  const calls = await mockFmp(page, { mode: '429once' });
  check(/Updated/.test(await afterToast(page, () => page.click('#btn-refresh'), '.ok', 30000)) && calls.hist429 === 1, 'rate limit retried once then succeeded');
  // A fatal error during per-name history cancels the other workers and keeps its message.
  await page.unroute('https://financialmodelingprep.com/**');
  const c401 = await mockFmp(page, { date: '2026-10-02', hh: 16, mm: 0, sessions: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], mode: '401hist' });
  await page.click('#btn-refresh');
  await page.waitForSelector('#sheet-data.on', { timeout: 30000 });
  await page.waitForTimeout(1500);
  check(c401.history < 40 && /rejected the API key/.test(await page.textContent('#refresh-note')), `fatal error stops the workers (${c401.history} history requests) and the message stays`);
  await page.click('#sheet-data [data-close]');
  const unexpected = log.errors.filter(e => !/Failed to load resource/.test(e));   // the mocked 401/429/abort log themselves
  check(unexpected.length === 0, `console clean apart from the provoked failures: ${JSON.stringify(unexpected)}`);
  await ctx.close();
}

// ---- 5b. storage failure, bundle failure, deep link, focus ---------------------------------
{
  const { ctx, page, log } = await newPage();
  await page.addInitScript(() => { localStorage.setItem('fmpKey', JSON.stringify('k')); indexedDB.open = () => { throw new Error('blocked'); }; });
  await load(page);
  await mockFmp(page, {});
  const t = await afterToast(page, () => page.click('#btn-refresh'));
  check(/Updated/.test(t) && /not saved/.test(t), `storage failure is reported: ${t}`);
  await ctx.close();
}
{
  const { ctx, page, log } = await newPage();
  await page.route('**/data/history.json', r => r.fulfill({ status: 500, body: 'x' }));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.list .empty');
  await page.click('#status'); await page.waitForSelector('#sheet-data.on');
  check(await page.locator('#do-refresh').isDisabled() && /failed to load/.test(await page.textContent('#refresh-note')), 'bundle failure: data sheet explains and refresh is disabled');
  check(!log.errors.some(e => /pageerror/.test(e)), `no page error on bundle failure: ${JSON.stringify(log.errors.filter(e => /pageerror/.test(e)))}`);
  await ctx.close();
}
{
  const { ctx, page, log } = await newPage();
  await page.goto('about:blank');
  await page.goto(BASE + '#MU', { waitUntil: 'networkidle' });
  await page.waitForSelector('#detail.on');
  await page.click('#d-back'); await page.waitForTimeout(300);
  check(page.url().startsWith(BASE) && !page.url().includes('#') && !(await page.locator('#detail').evaluate(e => e.classList.contains('on'))), `deep-linked detail closes in place (${page.url()})`);
  await page.waitForSelector('.list:not(.skeleton) .row');
  await page.click('#status'); await page.waitForTimeout(350);
  check(await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-close')), 'data sheet takes focus');
  check(await page.evaluate(() => document.getElementById('app').inert === true), 'main content is inert behind the modal data sheet');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'status' && document.getElementById('app').inert === false), 'focus returns to the status button on close');
  // the settings panel is compact and non-modal: the list stays visible and usable
  await page.click('#btn-settings'); await page.waitForTimeout(400);
  const peek = await page.evaluate(() => { const sh = document.getElementById('sheet-settings').getBoundingClientRect(); const row = document.querySelector('.list .row').getBoundingClientRect();
    return { covers: sh.height / innerHeight, rowVisible: row.bottom < sh.top, inert: document.getElementById('app').inert, backdrop: document.getElementById('backdrop').hidden }; });
  check(peek.covers <= 0.53 && peek.rowVisible && !peek.inert && peek.backdrop, `settings panel leaves the list visible (${Math.round(peek.covers * 100)}% of the screen, no dim)`);
  await page.click('[data-flag="vol"]'); await page.waitForTimeout(500);
  check((await page.locator('.list .row').first().isVisible()), 'rows stay visible while toggling');
  await page.locator('.list .row').first().click(); await page.waitForSelector('#detail.on');
  check(await page.evaluate(() => document.getElementById('sheet-settings').hidden), 'opening a ticker closes the settings panel');
  await page.click('#d-back'); await page.waitForTimeout(300);
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 5c. motion: pills, scrubbing, reduced motion ----------------------------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  await page.waitForTimeout(700);
  await page.click('#btn-settings'); await page.waitForTimeout(400);
  const pillOn = await page.evaluate(() => { const seg = document.querySelector('#sheet-settings .seg'); const on = seg.querySelector('button[aria-pressed="true"]'), pill = seg.querySelector('.pill');
    return Math.abs(pill.getBoundingClientRect().left - on.getBoundingClientRect().left) < 2 && Math.abs(pill.getBoundingClientRect().width - on.getBoundingClientRect().width) < 2; });
  check(pillOn, 'segmented pill sits under the pressed button');
  await page.click('[data-window="6m"]'); await page.waitForTimeout(450);
  const pillMoved = await page.evaluate(() => { const seg = document.querySelector('#sheet-settings .seg'); const on = seg.querySelector('button[aria-pressed="true"]'), pill = seg.querySelector('.pill'); return on.dataset.window === '6m' && Math.abs(pill.getBoundingClientRect().left - on.getBoundingClientRect().left) < 2; });
  check(pillMoved, 'pill follows the new selection');
  await page.click('[data-flag="residual"]'); await page.waitForTimeout(700);
  const settled = await rows(page);
  check(settled[0].v === (await rows(page))[0].v && /^[+\u2212]\d+\.\d%$/.test(settled[0].v), `values settle after the tick animation: ${settled[0].v}`);
  await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(400);
  await page.click('.list .row[data-t="NVDA"]'); await page.waitForSelector('#detail.on'); await page.waitForTimeout(700);
  const price = await page.textContent('.d-price');
  await page.hover('#chart svg', { position: { x: 100, y: 100 } }); await page.waitForTimeout(60);
  check((await page.textContent('.d-price')) !== price, 'scrubbing moves the headline price');
  await page.mouse.move(2, 2); await page.waitForTimeout(60);
  check((await page.textContent('.d-price')) === price, 'headline price restores after scrubbing');
  check(log.errors.length === 0, `console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage(); await curlTransport(page);
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await load(page);
  check((await rows(page)).length > 850 && (await page.evaluate(() => document.getAnimations().length)) === 0, 'reduced motion: full list, no running animations');
  await page.click('#btn-settings'); await page.click('[data-flag="vol"]'); await page.waitForTimeout(100);
  check((await page.evaluate(() => document.getAnimations().length)) === 0 && errs.length === 0, 'reduced motion: settings change without animations');
  await ctx.close();
}

// ---- 5d. group view -------------------------------------------------------------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  await page.click('[data-view="groups"]'); await page.waitForTimeout(500);
  let g = await rows(page);
  check(g.length === 38 && g[0].rk === '1' && /^[+\u2212]\d+\.\d%$/.test(g[0].v), `groups view ranks ${g.length} groups`);
  check(await page.locator('#search').isHidden() && /38 groups/.test(await page.textContent('#dist-n')), 'search hidden and count says groups');
  check(await noOverflow(page), 'no horizontal overflow in groups view');
  await page.click('#btn-settings'); await page.click('[data-display="pct"]'); await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(500);
  g = await rows(page);
  check(g[0].v === '100%' && g[g.length - 1].v === '0%', 'group display modes apply');
  await page.click('#btn-settings'); await page.click('#reset'); await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(400);
  const first = (await rows(page))[0].t;
  await page.locator('.list .row').first().click(); await page.waitForTimeout(500);
  const drill = await rows(page);
  check(drill.length > 8 && drill.length < 60 && (await page.textContent('#filter-text')).includes(first) && drill[0].rk === '1', `tapping a group drills into its ${drill.length} names`);
  await page.click('#filter-clear'); await page.waitForTimeout(400);
  check((await rows(page)).length === 38, 'clearing the filter returns to the groups');
  await page.click('[data-view="stocks"]'); await page.waitForTimeout(400);
  check((await rows(page)).length > 850 && !(await page.locator('#search').isHidden()), 'back to stocks');
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.list:not(.skeleton) .row');
  check((await rows(page)).length > 850, 'view persists as stocks');
  check(log.errors.length === 0 && log.fmp.length === 0, `console clean, no FMP: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 5e. rank history ---------------------------------------------------------------------
{
  const { ctx, page, log } = await newPage();
  await load(page);
  await page.waitForSelector('.list .row .pd', { timeout: 15000 });
  const r = await rows(page);
  check(r.length > 850 && r.slice(0, 20).every(x => /1w$/.test(x.sub)), `rows carry a week-ago rank delta (${r[0].sub})`);
  await page.click('.list .row[data-t="MU"]'); await page.waitForSelector('#detail.on');
  const d = await page.textContent('.page-body');
  check(/Rank history/.test(d) && /1w ago #\d+/.test(d) && /1m ago #\d+/.test(d), 'detail shows the rank a week and a month ago');
  await page.click('#d-back'); await page.waitForTimeout(300);
  await page.click('#btn-settings'); await page.click('[data-flag="residual"]'); await page.click('#sheet-settings [data-close]'); await page.waitForTimeout(700);
  check((await rows(page)).slice(0, 20).every(x => /1w$/.test(x.sub)), 'past deltas follow the settings');
  check(log.fmp.length === 0 && log.errors.length === 0, `no requests, console clean: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

// ---- 6. viewports --------------------------------------------------------------------------
for (const [name, vp, mobile] of [['320', { width: 320, height: 640 }, true], ['430', { width: 430, height: 932 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
  const { ctx, page, log } = await newPage(vp, mobile);
  await load(page);
  check(await noOverflow(page), `no horizontal overflow at ${name}`);
  await shot(page, `rank-${name}`);
  await page.click('.list .row[data-t="NVDA"]'); await page.waitForSelector('#detail.on');
  check(await noOverflow(page), `detail: no horizontal overflow at ${name}`);
  await shot(page, `detail-${name}`);
  await page.click('#d-back'); await page.waitForTimeout(300);
  await page.click('#btn-settings'); await page.waitForTimeout(350);
  await shot(page, `settings-${name}`);
  check(log.errors.length === 0, `console clean at ${name}: ${JSON.stringify(log.errors)}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

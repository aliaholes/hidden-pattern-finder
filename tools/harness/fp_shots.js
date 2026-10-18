#!/usr/bin/env node
/* fp_shots.js -- headless check of the Fingerprint tab: run the box sets, save shots/fp-*.png, fail on console errors or
 * non-local requests, and correlate the JS spectra with tools/harness/fp_lists.py's Python reference.
 * usage: python3 -m http.server 8765 (repo root) ; python tools/harness/fp_lists.py DATA ... ; node fp_shots.js [DATA] [CHECK_DIR]
 * CHECK_DIR/lists.json: { set: [files], ..., "_runs": [[name, set, control|null, shot.png], ...] } (optional py_<set>.f32 references) */
'use strict';
var path = require('path'), fs = require('fs');
var pw; try { pw = require('playwright'); } catch (e) { pw = require('/workspace/pwt/node_modules/playwright'); }
var DATA = process.argv[2] || '/workspace/hpf-data', CK = process.argv[3] || path.join(DATA, 'fp_check'), SHOTS = path.join(__dirname, '..', '..', 'shots');
var L = JSON.parse(fs.readFileSync(path.join(CK, 'lists.json')));
function corr(a, b) { // Pearson over all bins except the DC neighbourhood
  var S = 512, c = 256, xs = [], ys = [];
  for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) if (Math.abs(y - c) > 2 || Math.abs(x - c) > 2) { xs.push(a[y * S + x]); ys.push(b[y * S + x]); }
  var n = xs.length, mx = 0, my = 0, i; for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
  var sxy = 0, sxx = 0, syy = 0, mad = 0; for (i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; mad = Math.max(mad, Math.abs(xs[i] - ys[i])); }
  return { r: sxy / Math.sqrt(sxx * syy), max_abs_diff_ln: mad };
}
(async function () {
  var browser = await pw.chromium.launch(), page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  var errors = [], external = [], out = { runs: {} };
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });
  page.on('request', function (r) { if (!/^http:\/\/127\.0\.0\.1:8765\//.test(r.url()) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  await page.goto('http://127.0.0.1:8765/index.html'); await page.waitForTimeout(500);
  await page.click('#tab-fp');
  async function run(name, set, ctl, shot) {
    await page.setInputFiles('#fpFileA', L[set]);
    if (ctl) await page.setInputFiles('#fpFileB', L[ctl]); else if (await page.isVisible('#fpClearB')) await page.click('#fpClearB');
    var t0 = Date.now();
    await page.evaluate(function () { window.__fp = null; document.getElementById('status').textContent = ''; });
    await page.click('#fpRun');
    await page.waitForFunction(function () { var s = document.getElementById('status'); return (window.__fp && /^Done\./.test(s.textContent)) || s.classList.contains('err'); }, null, { timeout: 1200000 });
    var st = await page.textContent('#status');
    var res = await page.evaluate(function () { var f = window.__fp; return { nA: f.A.n, nB: f.B && f.B.n, logP: Array.from(f.A.logP), peaksA: f.A.peaks.slice(0, 5), peaksCmp: f.cmp ? f.cmp.peaks.slice(0, 5) : null, peaksB: f.B ? f.B.peaks.slice(0, 5) : null, skipped: f.A.skipped.concat(f.B ? f.B.skipped : []) }; });
    await page.locator('#fpOut').screenshot({ path: path.join(SHOTS, shot) });
    var r = { status: st, seconds: (Date.now() - t0) / 1000, nA: res.nA, nB: res.nB, skipped: res.skipped, peaksA: res.peaksA, peaksB: res.peaksB, peaksCmp: res.peaksCmp };
    var py = path.join(CK, 'py_' + set + '.f32');
    if (fs.existsSync(py)) { var b = fs.readFileSync(py); r.js_vs_python = corr(res.logP, new Float32Array(b.buffer, b.byteOffset, b.length / 4)); }
    out.runs[name] = r; console.error(name, JSON.stringify(r.js_vs_python || {}), st);
  }
  var RUNS = L._runs || [['nbpro_vs_commons', 'nbpro_step1', 'commons', 'fp-nbpro-vs-commons.png'], ['nb2x_vs_commons', 'nb2_x', 'commons', 'fp-nb2x-vs-commons.png'],
    ['sdmarked_vs_photos', 'sd_marked', 'photos', 'fp-sdmarked-vs-photos.png'], ['commons_alone', 'commons', null, 'fp-commons-alone.png']];
  for (var i = 0; i < RUNS.length; i++) await run.apply(null, RUNS[i]);
  if (!L._runs) await page.screenshot({ path: path.join(SHOTS, 'fp-page.png'), fullPage: true });
  out.errors = errors; out.external_requests = external;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  if (errors.length || external.length) process.exit(2);
})().catch(function (e) { console.error(e); process.exit(1); });

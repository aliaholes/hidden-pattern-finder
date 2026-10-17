#!/usr/bin/env node
/* shots.js -- load the page in headless Chromium, fail on any console error or any request that leaves localhost,
 * exercise the new features with sample images, and save screenshots to shots/.
 * usage: (serve the repo: python3 -m http.server 8765) then  node shots.js [DATA_DIR]   (needs the playwright package) */
'use strict';
var path = require('path'), fs = require('fs');
var pw; try { pw = require('playwright'); } catch (e) { pw = require(path.join('/workspace/pwt/node_modules/playwright')); }
var DATA = process.argv[2] || path.join(__dirname, '..', '..', '..', 'hpf-data'), SHOTS = path.join(__dirname, '..', '..', 'shots'), URL = 'http://127.0.0.1:8765/index.html';
function setOf(g, s) { var d = path.join(DATA, 'sets', g, s); return fs.readdirSync(d).filter(function (f) { return /\.png$/.test(f); }).sort().map(function (f) { return path.join(d, f); }); }
(async function () {
  var browser = await pw.chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  var errors = [], external = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });
  page.on('request', function (r) { if (!/^http:\/\/127\.0\.0\.1:8765\//.test(r.url()) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
  await page.goto(URL); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '00-page-loaded.png') });
  async function one(file, shot) {
    await page.click('#tab-one');
    await page.setInputFiles('#file1', file);
    await page.waitForFunction(function () { return /^Done\./.test(document.getElementById('status').textContent) && !/Reading/.test(document.getElementById('wmList').textContent); }, null, { timeout: 300000 });
    await page.locator('#facts').screenshot({ path: path.join(SHOTS, shot) });
  }
  await one(path.join(DATA, 'samples', 'sd_style_test.png'), '01-one-metadata-and-dwtdct-found.png');
  await page.screenshot({ path: path.join(SHOTS, '01b-one-full-page.png'), fullPage: true });
  await one(path.join(DATA, 'samples', 'C.jpg'), '02-one-c2pa-manifest.png');
  async function many(set, ctl, shot) {
    await page.click('#tab-many');
    await page.setInputFiles('#file2', set);
    if (ctl.length) await page.setInputFiles('#file3', ctl);
    else if (await page.isVisible('#clearCtl')) await page.click('#clearCtl');
    await page.click('#runMany');
    await page.waitForFunction(function () { return /^Done\./.test(document.getElementById('status').textContent) || document.getElementById('status').classList.contains('err'); }, null, { timeout: 600000 });
    var st = await page.textContent('#status');
    if (await page.isHidden('#multi')) throw new Error('set run failed: ' + st);
    await page.locator('#verdict').screenshot({ path: path.join(SHOTS, shot + '-verdict.png') });
    await page.locator('#multi').screenshot({ path: path.join(SHOTS, shot + '-details.png') });
    return st;
  }
  var r1 = await many(setOf('g0', 'fixed_pattern'), setOf('g1', 'clean'), '03-many-fixed-pattern-vs-control');
  var r2 = await many(setOf('g0', 'dwtdct_sdxl'), [], '04-many-dwtdct-grid-no-control');
  var r3 = await many(setOf('g0', 'clean_jpeg75'), setOf('g1', 'clean_jpeg75'), '05-many-jpeg-vs-jpeg-control');
  var bigDir = path.join(DATA, 'big'), r4 = null;
  if (fs.existsSync(bigDir)) { // 1536 x 2816 (Gemini-sized): proves the raised cap runs in a real browser
    var big = fs.readdirSync(bigDir).filter(function (f) { return /\.png$/.test(f); }).sort().map(function (f) { return path.join(bigDir, f); });
    r4 = await many(big, [], '06-many-1536x2816');
  }
  console.log(JSON.stringify({ errors: errors, external_requests: external, status: [r1, r2, r3, r4] }, null, 1));
  await browser.close();
  if (errors.length || external.length) process.exit(2);
})().catch(function (e) { console.error(e); process.exit(1); });

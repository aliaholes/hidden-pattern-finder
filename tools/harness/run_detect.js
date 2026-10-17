#!/usr/bin/env node
/* run_detect.js -- run the page's OWN detection code (meter.js, wmdecode.js, decode.js: the same files the browser
 * loads, no port) over the sets make_sets.py built, and write RESULTS.md.
 *   - Many images (Coh.evaluate): per set of N same-size images, the verdict; "alarm" = any anchored off-grid bin;
 *     grid-anchored bins (stricter floor) are counted separately.
 *   - Set vs control (cohCompare): each set against the CLEAN set of the NEXT group (different photos).
 *   - DWT-DCT reader (wmdecode.js), per image: MATCH rate, and bit-for-bit agreement with the Python decoder.
 * usage: node run_detect.js [DATA_DIR] [OUT.md]   (DATA_DIR default ../../../hpf-data)  */
'use strict';
var fs = require('fs'), path = require('path');
var here = __dirname, repo = path.join(here, '..', '..');
global.self = global;
require(path.join(repo, 'meter.js')); require(path.join(repo, 'wmdecode.js')); require(path.join(repo, 'decode.js'));
var M = global.HPMeter, WM = global.HPWm, D = global.HPDecode;
var DATA = process.argv[2] || path.join(here, '..', '..', '..', 'hpf-data'), OUT = process.argv[3] || path.join(repo, 'RESULTS.md');
var SETS = path.join(DATA, 'sets'), dec = JSON.parse(fs.readFileSync(path.join(SETS, 'decoders.json'), 'utf8'));
var groups = fs.readdirSync(SETS).filter(function (g) { return /^g\d+$/.test(g); }).sort();
var setNames = fs.readdirSync(path.join(SETS, groups[0])).sort();
var MARKED = { dwtdct_sd1: 'invisible-watermark dwtDct, "StableDiffusionV1"', dwtdct_sdxl: 'invisible-watermark dwtDct, SDXL 48-bit', dwtdct_sd1_jpeg90: 'dwtDct "StableDiffusionV1", then JPEG q90',
  dwtdctsvd_sd1: 'invisible-watermark dwtDctSvd, "StableDiffusionV1"', rivagan: 'invisible-watermark rivaGan (32 bits)', trustmark: 'Adobe TrustMark Q (61 bits)', fixed_pattern: 'fixed additive pattern, 40 carriers of +-0.5 level each (synthetic, SynthID-like)' };
var CLEAN = { clean: 'clean photos (Picsum JPEG, decoded)', clean_jpeg75: 'clean, re-saved JPEG q75', clean_resized: 'clean, bicubic 80 % down + back up' };

function loadSet(g, s) {
  var dir = path.join(SETS, g, s);
  return Promise.all(fs.readdirSync(dir).filter(function (f) { return /\.png$/.test(f); }).sort().map(function (f) {
    return D.decodePNG(fs.readFileSync(path.join(dir, f))).then(function (r) { r.file = g + '/' + f.replace('.png', ''); return r; });
  }));
}
function feed(imgs) { var c = new M.Coh(imgs[0].H, imgs[0].W, M.CH_ALL.slice()); imgs.forEach(function (im) { c.feed(im.rgb, im.W, im.H); }); return c; }

(async function () {
  var t0 = Date.now(), rows = {}, cleanCoh = {};
  for (var gi = 0; gi < groups.length; gi++) { var g = groups[gi]; cleanCoh[g] = feed(await loadSet(g, 'clean')); }
  for (var si = 0; si < setNames.length; si++) {
    var s = setNames[si], r = rows[s] = { sets: 0, alarm: 0, grid_alarm: 0, n_anch: [], n_grid_strict: [], ctl_alarm: 0, ctl_bins: [], wm_match: 0, wm_n: 0, eq_bits: 0, eq_total: 0, eq_images: 0, eq_exact: 0, N: 0 };
    for (gi = 0; gi < groups.length; gi++) {
      g = groups[gi];
      var imgs = await loadSet(g, s), coh = s === 'clean' ? cleanCoh[g] : feed(imgs), ev = coh.evaluate(0.01);
      r.sets++; r.N = imgs.length; r.n_anch.push(ev.n_anch); r.n_grid_strict.push(ev.n_grid_strict);
      if (ev.n_anch > 0) r.alarm++;
      if (ev.n_grid_strict > 0) r.grid_alarm++;
      var ctl = cleanCoh[groups[(gi + 1) % groups.length]], cmp = M.cohCompare(coh, ctl, 0.01);
      r.ctl_bins.push(cmp.n_set_only + '/' + cmp.n_set_only_grid);
      if (cmp.n_set_only + cmp.n_set_only_grid > 0) r.ctl_alarm++;
      var pyBits = /^(clean|dwtdct_sd1|dwtdct_sdxl|dwtdct_sd1_jpeg90)$/.test(s) ? ((dec.sets[s] || {}).bits || {}) : {}; // Python bits from the dwtDct decoder only
      imgs.forEach(function (im) {
        var w = WM.read(im.rgb, im.H, im.W);
        r.wm_n++; if (w.verdict !== 'NO-MATCH') r.wm_match++;
        var ref = pyBits[im.file], mine = null;
        if (ref) {
          mine = ref.length === 136 ? w.known[0].bits : (ref.length === 48 ? w.known[1].bits : null);
          if (mine) { var same = 0; for (var k = 0; k < ref.length; k++) if (ref[k] === mine[k]) same++; r.eq_bits += same; r.eq_total += ref.length; r.eq_images++; if (same === ref.length) r.eq_exact++; }
        }
      });
      process.stderr.write('\r' + s + ' ' + g + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)        ');
    }
  }
  var N = rows.clean.N, md = [];
  md.push('# Harness results', '');
  md.push('Produced by `tools/harness/run_detect.js` on ' + new Date().toISOString().slice(0, 10) + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s, node ' + process.version + ', ' + M.VERSION + ', ' + WM.VERSION + ').');
  md.push('Photos: ' + groups.length * N + ' Unsplash-licensed photos from Lorem Picsum, 512 x 512 (`tools/harness/fetch_photos.py`, manifest with sha256 in the data dir), split into ' + groups.length + ' disjoint groups of ' + N + '. Each row below is ' + groups.length + ' sets of N = ' + N + ' images.', '');
  md.push('## 1. Embedding check (each mark\'s OWN decoder, Python)', '', '| set | images | mean bit accuracy | min | decoded perfectly |', '|---|---|---|---|---|');
  Object.keys(dec.sets).forEach(function (s) { var d = dec.sets[s]; md.push('| ' + s + (s === 'clean' ? ' (dwtDct decoder on unmarked: chance level)' : '') + ' | ' + d.n + ' | ' + d.mean_bit_accuracy.toFixed(3) + ' | ' + d.min_bit_accuracy.toFixed(3) + ' | ' + d.perfect + ' |'); });
  if (!dec.have_rivagan) md.push('', 'rivaGan: not run (onnxruntime missing).');
  if (!dec.have_trustmark) md.push('', 'TrustMark: not run (package missing).');
  md.push('', '## 2. Many images (phase coherence, alpha 0.01 Bonferroni) and Set vs control', '');
  md.push('"anchored" = sets with at least one anchored OFF-grid bin (the page\'s red verdict). "grid-anchored" = sets with a grid bin past the stricter floor (p x 1/' + M.GRID_STRICT + '). "vs control" = sets with at least one SET-ONLY bin against the clean set of the next group (two-sample test); bins listed as off-grid/grid per set.', '');
  md.push('| set | kind | anchored (of ' + groups.length + ') | anchored bins per set | grid-anchored (of ' + groups.length + ') | grid bins per set | vs control: alarms (of ' + groups.length + ') | set-only bins off/grid |', '|---|---|---|---|---|---|---|---|');
  setNames.forEach(function (s) {
    var r = rows[s], kind = MARKED[s] ? 'marked: ' + MARKED[s] : (CLEAN[s] ? 'clean: ' + CLEAN[s] : s);
    md.push('| ' + s + ' | ' + kind + ' | ' + r.alarm + ' | ' + r.n_anch.join(', ') + ' | ' + r.grid_alarm + ' | ' + r.n_grid_strict.join(', ') + ' | ' + r.ctl_alarm + ' | ' + r.ctl_bins.join(', ') + ' |');
  });
  var cl = ['clean', 'clean_jpeg75', 'clean_resized'], mk = setNames.filter(function (s) { return MARKED[s]; });
  function sum(names, key) { return names.reduce(function (a, s) { return a + rows[s][key]; }, 0); }
  var ncl = cl.length * groups.length;
  md.push('', '**Summary.** False alarms on the ' + ncl + ' clean sets (clean, JPEG q75, resized): off-grid anchored ' + sum(cl, 'alarm') + ' / ' + ncl + ', grid-anchored ' + sum(cl, 'grid_alarm') + ' / ' + ncl + ', vs control ' + sum(cl, 'ctl_alarm') + ' / ' + ncl + '. Hits on marked sets (off-grid anchored / vs control): ' + mk.map(function (s) { return s + ' ' + rows[s].alarm + '/' + rows[s].ctl_alarm + ' of ' + groups.length; }).join(', ') + '.');
  md.push('', '## 3. In-browser DWT-DCT reader (wmdecode.js), per image', '');
  md.push('"MATCH" = a known payload (SD "StableDiffusionV1" 136 bits or SDXL 48 bits) matched with binomial p < 1e-6. "agrees with Python" = bits identical to imwatermark\'s decoder on the same pixels.', '');
  md.push('| set | images | MATCH | agrees with Python (bits) | images bit-identical |', '|---|---|---|---|---|');
  setNames.forEach(function (s) { var r = rows[s]; md.push('| ' + s + ' | ' + r.wm_n + ' | ' + r.wm_match + ' (' + (100 * r.wm_match / r.wm_n).toFixed(1) + ' %) | ' + (r.eq_total ? (100 * r.eq_bits / r.eq_total).toFixed(3) + ' %' : 'n/a') + ' | ' + (r.eq_images ? r.eq_exact + ' / ' + r.eq_images : 'n/a') + ' |'); });
  fs.writeFileSync(OUT, md.join('\n') + '\n');
  process.stderr.write('\nwrote ' + OUT + '\n');
})().catch(function (e) { console.error(e); process.exit(1); });

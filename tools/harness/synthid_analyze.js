#!/usr/bin/env node
/* synthid_analyze.js -- the SynthID experiment, with the page's own meter.js (Coh / cohCompare / patternPictures).
 * usage: node synthid_analyze.js CONFIG.json OUT_DIR
 * CONFIG: { "sets": { name: { "files": [png...], "groups": [label per file] } },
 *           "vs":   [[set, control], ...],                // Many images + Set vs control, alpha 0.01
 *           "split": [set, ...],                          // split-half replication by GROUP (seed / source image)
 *           "cross": [[setA, setB], ...],                 // do the top bins recur (same cycles per image)?
 *           "picture": set }                              // the pattern, made visible
 * Writes OUT_DIR/summary.json (counts, coarse locations) and OUT_DIR/bins_local.json (per-bin detail: LOCAL ONLY). */
'use strict';
var fs = require('fs'), path = require('path');
global.self = global;
var repo = path.join(__dirname, '..', '..');
require(path.join(repo, 'meter.js')); require(path.join(repo, 'decode.js'));
var M = global.HPMeter, D = global.HPDecode;
var cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
var K = cfg.topK || 200, SPLITS = cfg.splits || 20, CH2 = ['G', 'Y'];
function load(f) { return D.decodePNG(fs.readFileSync(f)); }
function rnd(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function coarse(b, H, W) { // coarse location only: period band and angle band
  var p = b.period_px, a = Math.round(b.angle_deg / 15) * 15;
  var band = p < 3 ? '<3 px' : p < 6 ? '3-6 px' : p < 12 ? '6-12 px' : p < 32 ? '12-32 px' : p < 100 ? '32-100 px' : '>100 px';
  return band + ' @ ~' + a + '\u00b0';
}
function summarizeBins(bins) { var c = {}; bins.forEach(function (b) { var k = coarse(b); c[k] = (c[k] || 0) + 1; }); return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 8).map(function (k) { return k + ' (' + c[k] + ')'; }); }

// per-group Coh on two channels (for split-half / cross), plus a full Coh for the set
async function run() {
  var summary = { topK: K, splits: SPLITS, sets: {}, vs: [], split: {}, cross: [] }, local = { sets: {}, vs: [] };
  var full = {}, groupsOf = {}, dims = {};
  for (var name in cfg.sets) {
    var S = cfg.sets[name], first = await load(S.files[0]), H = first.H, W = first.W, c = new M.Coh(H, W, M.CH_ALL.slice()), G = {};
    for (var i = 0; i < S.files.length; i++) {
      var im = i ? await load(S.files[i]) : first;
      if (im.W !== W || im.H !== H) throw new Error(S.files[i] + ' is ' + im.W + 'x' + im.H + ', set ' + name + ' is ' + W + 'x' + H);
      c.feed(im.rgb, W, H);
      var g = S.groups ? S.groups[i] : String(i);
      if (cfg.split && cfg.split.indexOf(name) >= 0 || (cfg.cross || []).some(function (p) { return p.indexOf(name) >= 0; })) {
        if (!G[g]) G[g] = new M.Coh(H, W, CH2.slice());
        G[g].feed(im.rgb, W, H);
      }
      process.stderr.write('\r' + name + ' ' + (i + 1) + '/' + S.files.length + '      ');
    }
    full[name] = c; groupsOf[name] = G; dims[name] = [H, W];
    var ev = c.evaluate(0.01);
    summary.sets[name] = { N: ev.N, H: H, W: W, groups: S.groups ? Object.keys(G).length || new Set(S.groups).size : ev.N, verdict: ev.verdict, underpowered: ev.underpowered, n_min: ev.n_min, cstar: ev.cstar,
      n_anch: ev.n_anch, n_grid_strict: ev.n_grid_strict, n_shared: ev.n_shared, rho_res: ev.diversity.rho_res, rho_raw: ev.diversity.rho_raw, diversity_warn: ev.diversity.warn,
      anchored_where: summarizeBins(ev.bins), grid_where: summarizeBins(ev.grid_bins) };
    local.sets[name] = { bins: ev.bins.slice(0, 300).map(function (b) { return [b.ch, b.fy, b.fx, +b.C.toFixed(4)]; }), grid_bins: ev.grid_bins.slice(0, 100).map(function (b) { return [b.ch, b.fy, b.fx, +b.C.toFixed(4)]; }) };
  }
  (cfg.vs || []).forEach(function (p) {
    var cm = M.cohCompare(full[p[0]], full[p[1]], 0.01);
    summary.vs.push({ set: p[0], control: p[1], n_set_only: cm.n_set_only, n_set_only_grid: cm.n_set_only_grid, where: summarizeBins(cm.bins), where_grid: summarizeBins(cm.grid_bins) });
    local.vs.push({ set: p[0], control: p[1], bins: cm.bins.slice(0, 300).map(function (b) { return [b.ch, b.fy, b.fx, +b.C.toFixed(4), +b.C_control.toFixed(4)]; }) });
  });
  // valid off-grid canonical bins, and per-bin C over a group subset (max over the two channels)
  function geom(H, W) {
    var Wh = Math.floor(W / 2) + 1, nb = H * Wh, ok = new Uint8Array(nb), sy = H / 16, sx = W / 16, m = 0;
    for (var y = 0; y < H; y++) { var fy = y <= Math.floor(H / 2) ? y : y - H; for (var x = 0; x < Wh; x++) {
      var i = y * Wh + x, grid = Math.abs(fy - M.roundHalfEven(fy / sy) * sy) <= 1 + 1e-9 || Math.abs(x - M.roundHalfEven(x / sx) * sx) <= 1 + 1e-9;
      var canon = !((x === 0 || (W % 2 === 0 && x === W / 2)) && y > Math.floor(H / 2));
      if (Math.sqrt(fy * fy + x * x) > 2 && !grid && canon) { ok[i] = 1; m++; } } }
    return { Wh: Wh, nb: nb, ok: ok, M: m };
  }
  function Cof(G, keys, g) {
    var C = new Float32Array(g.nb), N = 0;
    keys.forEach(function (k) { N += G[k].N; });
    CH2.forEach(function (ch) {
      var R = new Float64Array(g.nb), I = new Float64Array(g.nb);
      keys.forEach(function (k) { var U = G[k].U[ch]; for (var i = 0; i < g.nb; i++) { R[i] += U.r[i]; I[i] += U.i[i]; } });
      for (var i = 0; i < g.nb; i++) if (g.ok[i]) { var v = Math.hypot(R[i], I[i]) / N; if (v > C[i]) C[i] = v; }
    });
    return C;
  }
  function topK(C, g) { var idx = []; for (var i = 0; i < g.nb; i++) if (g.ok[i]) idx.push(i); idx.sort(function (a, b) { return C[b] - C[a]; }); return idx.slice(0, K); }
  (cfg.split || []).forEach(function (name) {
    var G = groupsOf[name], keys = Object.keys(G), hw = dims[name], g = geom(hw[0], hw[1]), r = rnd(12345), ov = [];
    if (keys.length < 4) { summary.split[name] = { error: 'fewer than 4 groups' }; return; }
    for (var s = 0; s < SPLITS; s++) {
      var sh = keys.slice(); for (var i = sh.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
      var A = sh.slice(0, Math.floor(sh.length / 2)), B = sh.slice(Math.floor(sh.length / 2));
      var ta = topK(Cof(G, A, g), g), tb = new Set(topK(Cof(G, B, g), g)), o = 0;
      ta.forEach(function (i) { if (tb.has(i)) o++; });
      ov.push(o);
    }
    var mean = ov.reduce(function (a, b) { return a + b; }, 0) / ov.length, chance = K * K / g.M;
    // hypergeometric tail for the mean overlap (rounded) as a single-split p-value
    var obs = Math.round(mean), p = 0, lg = function (n) { var s = 0; for (var q = 2; q <= n; q++) s += Math.log(q); return s; };
    var lc = function (n, k) { return lg(n) - lg(k) - lg(n - k); };
    for (var k2 = obs; k2 <= K; k2++) p += Math.exp(lc(K, k2) + lc(g.M - K, K - k2) - lc(g.M, K));
    summary.split[name] = { groups: keys.length, valid_bins: g.M, K: K, overlaps: ov, mean_overlap: +mean.toFixed(2), chance_overlap: +chance.toFixed(3), ratio: +(mean / chance).toFixed(1), p_single_split_at_mean: p };
  });
  (cfg.cross || []).forEach(function (pr) {
    var a = pr[0], b = pr[1], ga = geom(dims[a][0], dims[a][1]), gb = geom(dims[b][0], dims[b][1]);
    var ta = topK(Cof(groupsOf[a], Object.keys(groupsOf[a]), ga), ga), tb = topK(Cof(groupsOf[b], Object.keys(groupsOf[b]), gb), gb);
    function key(i, g, H) { var y = Math.floor(i / g.Wh), x = i % g.Wh, fy = y <= Math.floor(H / 2) ? y : y - H; return fy + ',' + x; }
    var sb = new Set(tb.map(function (i) { return key(i, gb, dims[b][0]); })), o = 0;
    ta.forEach(function (i) { if (sb.has(key(i, ga, dims[a][0]))) o++; });
    var Mc = Math.min(ga.M, gb.M);
    summary.cross.push({ a: a, b: b, K: K, overlap_same_cycles_per_image: o, chance: +(K * K / Mc).toFixed(3) });
  });
  if (cfg.picture) {
    var c = full[cfg.picture], ev = c.evaluate(0.01), mask = new Uint8Array(ev._keep.length);
    for (var q = 0; q < mask.length; q++) mask[q] = ev._keep[q] | ev._keepG[q];
    var pp = c.patternPictures(mask);
    local.picture = { set: cfg.picture, W: pp.W, H: pp.H, n_bins: pp.n_bins };
    fs.writeFileSync(path.join(OUT, 'picture_mean.rgba'), Buffer.from(pp.mean.buffer)); fs.writeFileSync(path.join(OUT, 'picture_rebuilt.rgba'), Buffer.from(pp.rebuilt.buffer));
    summary.picture = { set: cfg.picture, W: pp.W, H: pp.H, n_bins: pp.n_bins };
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(OUT, 'bins_local.json'), JSON.stringify(local));
  process.stderr.write('\nwrote ' + OUT + '\n');
}
run().catch(function (e) { console.error(e); process.exit(1); });

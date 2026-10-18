/* worker.js -- runs meter.js off the main thread. No network: it only receives pixels from the page and posts numbers and
 * small pictures back. (importScripts loads meter.js from this same folder, once, at start.) */
'use strict';
importScripts('meter.js');
var M = self.HPMeter;
var IMG = null, DIMG = null, COH = null, CACHE = {};

function boxDown(src, w, h, chans, maxSide) { // area-average down to fit maxSide; returns {data RGBA, w, h}
  var s = Math.min(1, maxSide / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  var out = new Uint8ClampedArray(tw * th * 4);
  for (var ty = 0; ty < th; ty++) {
    var y0 = Math.floor(ty * h / th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * h / th));
    for (var tx = 0; tx < tw; tx++) {
      var x0 = Math.floor(tx * w / tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * w / tw)), r = 0, g = 0, b = 0, n = 0;
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
        var i = y * w + x;
        if (chans === 1) { r += src[i]; } else { r += src[4 * i]; g += src[4 * i + 1]; b += src[4 * i + 2]; }
        n++;
      }
      var o = 4 * (ty * tw + tx);
      if (chans === 1) { out[o] = out[o + 1] = out[o + 2] = r / n; } else { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
      out[o + 3] = 255;
    }
  }
  return { data: out, w: tw, h: th };
}
// a heat ramp for spectra (black -> deep red -> red -> bone), so a peak reads at a glance
var RAMP = (function () {
  var stops = [[0, 7, 5, 5], [0.45, 90, 11, 16], [0.75, 215, 20, 30], [1, 243, 236, 230]], lut = new Uint8ClampedArray(256 * 3);
  for (var v = 0; v < 256; v++) {
    var t = v / 255, k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    var a = stops[k], b = stops[k + 1], f = (t - a[0]) / (b[0] - a[0]);
    for (var c = 0; c < 3; c++) lut[3 * v + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
  }
  return lut;
})();
function ramp(u8) { var n = u8.length, out = new Uint8ClampedArray(n * 4); for (var i = 0; i < n; i++) { var v = u8[i]; out[4 * i] = RAMP[3 * v]; out[4 * i + 1] = RAMP[3 * v + 1]; out[4 * i + 2] = RAMP[3 * v + 2]; out[4 * i + 3] = 255; } return out; }
function pack(o) { return { w: o.w, h: o.h, buf: o.data.buffer }; }

function viewOf(perm, w, h) { // the map as a picture (sat-boost views in colour, like the Python's contact sheet)
  if (perm._map && perm._map.view) return { data: perm._map.view, chans: 4 };
  return { data: M.stretchToU8(perm._map.map, 1.0, 99.0), chans: 1 };
}

function runPerm(name, thumb) {
  var p = M.scanPerm(IMG, DIMG, name, { wantView: true, keepSpectrum: true });
  var v = viewOf(p), full = p._full;
  var vt = boxDown(v.data, IMG.W, IMG.H, v.chans, thumb);
  var spec = null, specFull = null;
  if (full && full.res && full.res.A) {
    specFull = ramp(M.stretchToU8(M.shiftedLog(full.res.A, full.h, full.w), 50.0, 99.95));
    spec = boxDown(specFull, full.w, full.h, 4, thumb);
  }
  CACHE = { name: name, p: p, v: v, specFull: specFull };   // the last one, for a fast detail view
  var out = { name: p.name, family: p.family, score: p.score, regions: {} };
  for (var rn in p.regions) { var r = p.regions[rn]; out.regions[rn] = { shape: r.shape, flat: r.flat, cands: r.cands, labelled: r.labelled, grid: r.grid, top: r.top }; }
  var tr = [vt.data.buffer];
  out.thumb = pack(vt);
  if (spec) { out.spec = pack(spec); tr.push(spec.data.buffer); }
  return { msg: out, transfer: tr };
}

function runDetail(name, maxSide) {
  var p = (CACHE.name === name) ? CACHE.p : M.scanPerm(IMG, DIMG, name, { wantView: true, keepSpectrum: true });
  var v = (CACHE.name === name) ? CACHE.v : viewOf(p), full = p._full;
  var big = boxDown(v.data, IMG.W, IMG.H, v.chans, maxSide), out = { name: name, view: pack(big), peaks: [] }, tr = [big.data.buffer];
  if (full && full.res && full.res.A) {
    var sf = ramp(M.stretchToU8(M.shiftedLog(full.res.A, full.h, full.w), 50.0, 99.95));
    var sp = boxDown(sf, full.w, full.h, 4, Math.min(maxSide, 900));
    out.spec = pack(sp); tr.push(sp.data.buffer);
    var ac = M.autocorr(full.res.S, full.h, full.w);
    var acu = ramp(M.stretchToU8(ac, 1.0, 99.9));
    // zoom on the central lags (the interesting part): crop +-min(h,w)/4 around the centre
    var cw = Math.max(32, Math.floor(full.w / 4)), ch = Math.max(32, Math.floor(full.h / 4)), cx = Math.floor(full.w / 2), cy = Math.floor(full.h / 2);
    var x0 = Math.max(0, cx - cw), y0 = Math.max(0, cy - ch), w2 = Math.min(full.w, cx + cw) - x0, h2 = Math.min(full.h, cy + ch) - y0;
    var crop = new Uint8ClampedArray(w2 * h2 * 4);
    for (var y = 0; y < h2; y++) crop.set(acu.subarray(4 * ((y0 + y) * full.w + x0), 4 * ((y0 + y) * full.w + x0 + w2)), 4 * y * w2);
    var acb = boxDown(crop, w2, h2, 4, Math.min(maxSide, 900));
    out.ac = pack(acb); out.acSpan = { lagX: cw, lagY: ch }; tr.push(acb.data.buffer);
    out.full = { h: full.h, w: full.w };
    out.peaks = full.res.peaks.slice(0, 24).map(function (q) { return { period_px: q.period_px, angle_deg: q.angle_deg, prominence: q.prominence, label: q.label, why: q.label_why, offaxis: q.lattice_offaxis, ix: q.ix, iy: q.iy }; });
  }
  return { msg: out, transfer: tr };
}

// unscored extra looks (not part of the calibrated battery; no score, no verdict)
function runExtra(kind, thumb, maxSide) {
  var H = IMG.H, W = IMG.W, n = H * W, d = IMG.rgb, out = new Uint8ClampedArray(n * 4), i, c;
  function put(i, r, g, b) { out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = 255; }
  if (kind === 'gamma25' || kind === 'gamma50') {
    var gm = kind === 'gamma25' ? 0.25 : 0.5, lut = new Uint8ClampedArray(256);
    for (i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gm) * 255;
    for (i = 0; i < n; i++) put(i, lut[d[3 * i]], lut[d[3 * i + 1]], lut[d[3 * i + 2]]);
  } else if (kind === 'sat999') {
    out = M.computePerm(IMG, 'satHSVx999:R-G', true).view;   // the same per-pixel HSV path as the scored boosts, at x999
  } else if (kind === 'levels' || kind === 'equalize') {
    for (c = 0; c < 3; c++) {
      var m = M.computePerm(IMG, (kind === 'levels' ? 'stretch:' : 'equalize:') + 'RGB'[c], false).map;
      for (i = 0; i < n; i++) { out[4 * i + c] = m[i] * 255; out[4 * i + 3] = 255; }
    }
  } else if (kind === 'chroma') {
    var cb = M.computePerm(IMG, 'YCbCr:Cb', false).map, cr = M.computePerm(IMG, 'YCbCr:Cr', false).map;
    var cb64 = Float64Array.from(cb), cr64 = Float64Array.from(cr), bcb = M.blur13(cb64, H, W), bcr = M.blur13(cr64, H, W);
    for (i = 0; i < n; i++) { var u = (cb64[i] - bcb[i]) * 24, v = (cr64[i] - bcr[i]) * 24; put(i, 128 + 1.402 * v, 128 - 0.344136 * u - 0.714136 * v, 128 + 1.772 * u); }
  } else if (kind === 'residual') {
    for (c = 0; c < 3; c++) {
      var pl = new Float64Array(n); for (i = 0; i < n; i++) pl[i] = d[3 * i + c];
      var bl = M.blur13(pl, H, W);
      for (i = 0; i < n; i++) { out[4 * i + c] = 128 + (pl[i] - bl[i]) * 12; out[4 * i + 3] = 255; }
    }
  }
  var t = boxDown(out, W, H, 4, thumb), big = boxDown(out, W, H, 4, maxSide);
  return { msg: { kind: kind, thumb: pack(t), view: pack(big) }, transfer: [t.data.buffer, big.data.buffer] };
}

self.onmessage = function (ev) {
  var m = ev.data;
  try {
    if (m.cmd === 'init') {
      IMG = { rgb: new Uint8Array(m.rgb), H: m.H, W: m.W };
      DIMG = M.quantDither(IMG, 1001);
      CACHE = {};
      self.postMessage({ cmd: 'ready', id: m.id });
    } else if (m.cmd === 'perm') {
      var r = runPerm(m.name, m.thumb || 220); r.msg.cmd = 'perm'; r.msg.id = m.id; self.postMessage(r.msg, r.transfer);
    } else if (m.cmd === 'detail') {
      var d = runDetail(m.name, m.maxSide || 1200); d.msg.cmd = 'detail'; d.msg.id = m.id; self.postMessage(d.msg, d.transfer);
    } else if (m.cmd === 'extra') {
      var e = runExtra(m.kind, m.thumb || 220, m.maxSide || 1200); e.msg.cmd = 'extra'; e.msg.id = m.id; self.postMessage(e.msg, e.transfer);
    } else if (m.cmd === 'coh-start') {
      COH = new M.Coh(m.H, m.W, M.CH_ALL.slice());
      self.postMessage({ cmd: 'coh-ready', id: m.id });
    } else if (m.cmd === 'coh-feed') {
      COH.feed(new Uint8Array(m.rgb), m.W, m.H);
      self.postMessage({ cmd: 'coh-fed', id: m.id, n: COH.N });
    } else if (m.cmd === 'coh-eval') {
      var evr = COH.evaluate(0.01), H = COH.H, W = COH.W, Wh = evr.Wh;
      // the coherence picture: full spectrum (Hermitian mirror), fftshifted, log-ish; red = anchored, blue = grid
      // drawn straight at display size, keeping the strongest class per pixel (an isolated red bin must survive)
      var sc = Math.min(1, 1100 / Math.max(H, W)), PW = Math.max(1, Math.round(W * sc)), PH = Math.max(1, Math.round(H * sc));
      var pri = new Float32Array(PW * PH), img = new Uint8ClampedArray(PW * PH * 4), sy = Math.floor(H / 2), sx = Math.floor(W / 2), cs = evr.cstar;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var yy = y, xx = x;
        if (x >= Wh) { yy = (H - y) % H; xx = W - x; }
        var bi = yy * Wh + xx, C = evr._Cmax[bi], cls = evr._cls[bi];
        var px = Math.min(PW - 1, Math.floor(((x + sx) % W) * sc)), py = Math.min(PH - 1, Math.floor(((y + sy) % H) * sc)), pi = py * PW + px;
        var g = Math.min(1, C / Math.max(cs, 1e-9)), pr = cls === 1 ? 4 : (cls === 2 ? 3 : (cls === 3 ? 2 : g));
        if (pr < pri[pi]) continue;
        pri[pi] = pr;
        var o = 4 * pi, gv = Math.sqrt(g) * 150;
        if (cls === 1) { img[o] = 255; img[o + 1] = 40; img[o + 2] = 40; }
        else if (cls === 2) { img[o] = 255; img[o + 1] = 210; img[o + 2] = 0; }
        else if (cls === 3) { img[o] = 60; img[o + 1] = 140; img[o + 2] = 255; }
        else { img[o] = gv; img[o + 1] = gv * 0.92; img[o + 2] = gv * 0.88; }
        img[o + 3] = 255;
      }
      var pic = { data: img, w: PW, h: PH };
      delete evr._Cmax; delete evr._cls;
      evr.bins = evr.bins.slice(0, 40);
      self.postMessage({ cmd: 'coh-result', id: m.id, ev: evr, pic: pack(pic) }, [pic.data.buffer]);
      COH = null;
    }
  } catch (err) {
    self.postMessage({ cmd: 'error', id: m.id, error: String(err && err.message || err) });
  }
};

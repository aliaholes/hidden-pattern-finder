/* fingerprint.js -- averaged noise-residual spectra ("fingerprints", after Marra et al. 2019 / Corvi et al. 2023).
 * Detection and display only. Pure functions; used by fpworker.js (accumulate) and the page (finalize).
 *
 * Per image: green channel of a fixed S x S centre crop (no resizing; offsets rounded down to a multiple of 8 so camera
 * JPEG 8-px blocks stay aligned across images; images smaller than S are skipped). Noise residual = crop minus a
 * Gaussian blur (sigma 1.5 px), applied exactly in the frequency domain (the residual's spectrum is F * (1 - G)),
 * which is fast, has no edge handling choices and matches tools/harness/fingerprints.py bit for bit in method.
 * Power |F(1-G)|^2 is summed over the set; the view is log(mean power). Autocorrelation = inverse FFT of mean power. */
(function (root) {
  'use strict';
  var S = 512, SIGMA = 1.5;
  var M = root.HPMeter || (typeof require !== 'undefined' ? require('./meter.js') : null);
  var HP2 = null; // (1 - G)^2 in unshifted (numpy fftfreq) order
  function hp2() {
    if (HP2) return HP2;
    HP2 = new Float64Array(S * S);
    var f = new Float64Array(S), k = 2 * Math.PI * Math.PI * SIGMA * SIGMA;
    for (var i = 0; i < S; i++) f[i] = (i < S / 2 ? i : i - S) * (1 / S);
    for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) { var g = Math.exp(-k * (f[y] * f[y] + f[x] * f[x])); HP2[y * S + x] = (1 - g) * (1 - g); }
    return HP2;
  }
  function cropOffset(H, W) { return { y: Math.floor((H - S) / 2 / 8) * 8, x: Math.floor((W - S) / 2 / 8) * 8 }; }
  // gray: Float64Array S*S (0..255). sum: Float64Array S*S accumulator (unshifted order). Returns sum.
  function accumulate(gray, sum) {
    var n = S * S, re = new Float64Array(n), im = new Float64Array(n), mean = 0, i;
    for (i = 0; i < n; i++) mean += gray[i]; mean /= n;
    for (i = 0; i < n; i++) re[i] = gray[i] - mean;
    M.fft2(re, im, S, S);
    var h = hp2();
    for (i = 0; i < n; i++) sum[i] += (re[i] * re[i] + im[i] * im[i]) * h[i];
    return sum;
  }
  function shift(a) { var o = new Float32Array(S * S), h = S / 2; for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) o[((y + h) % S) * S + ((x + h) % S)] = a[y * S + x]; return o; }
  function median(a) { a.sort(function (p, q) { return p - q; }); return a.length ? a[a.length >> 1] : 0; }
  // sum, n -> { logP (shifted, natural log of mean power), ac (shifted, normalised), white, radial, azim, peaks }
  function finalize(sum, n) {
    var N = S * S, c = S / 2, i, y, x, mp = new Float64Array(N);
    for (i = 0; i < N; i++) mp[i] = sum[i] / n;
    var logP = shift(mp.map(function (v) { return Math.log(v + 1e-6); }));
    // autocorrelation of the residual (Wiener-Khinchin)
    var re = Float64Array.from(mp), im = new Float64Array(N); M.ifft2(re, im, S, S);
    var r0 = re[0] || 1; for (i = 0; i < N; i++) re[i] /= r0; var ac = shift(re);
    // radial profile + ring medians (for whitening)
    var R = c + 1, rs = [], radial = new Float64Array(R), cnt = new Float64Array(R);
    for (i = 0; i < R; i++) rs.push([]);
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
      var r = Math.round(Math.hypot(y - c, x - c)); if (r >= R) continue;
      var v = logP[y * S + x]; radial[r] += v; cnt[r]++; rs[r].push(v);
    }
    var ringMed = new Float64Array(R);
    for (i = 0; i < R; i++) { radial[i] = cnt[i] ? radial[i] / cnt[i] : NaN; ringMed[i] = median(rs[i]); }
    // azimuthal profile over the outer band (r in [S/8, S/2)), 1-degree bins of the frequency direction 0..179
    var azim = new Float64Array(180), ac2 = new Float64Array(180);
    var white = new Float32Array(N), dev = [];
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
      var fx = x - c, fy = c - y, rr = Math.hypot(fx, fy), ri = Math.round(rr), k = y * S + x;
      white[k] = ri < R ? logP[k] - ringMed[ri] : 0;
      if (ri >= 4 && ri < R) dev.push(Math.abs(white[k]));
      if (rr >= S / 8 && rr < S / 2) { var a = Math.floor(((Math.atan2(fy, fx) * 180 / Math.PI) + 360) % 180); azim[a] += logP[k]; ac2[a]++; }
    }
    for (i = 0; i < 180; i++) azim[i] = ac2[i] ? azim[i] / ac2[i] : NaN;
    var mad = 1.4826 * median(dev) || 1e-9;
    return { S: S, n: n, logP: logP, ac: ac, white: white, mad: mad, radial: radial, azim: azim, peaks: peaks(white, mad, 8, 6) };
  }
  // local maxima of the whitened spectrum, upper half plane, |f| >= 4 bins, off the axis cross (|fx|, |fy| > 2), z = white / MAD
  function peaks(white, mad, K, zmin) {
    var c = S / 2, out = [];
    for (var y = 1; y < S - 1; y++) for (var x = 1; x < S - 1; x++) {
      var fx = x - c, fy = c - y; if (fy < 0 || (fy === 0 && fx <= 0)) continue;
      var r = Math.hypot(fx, fy); if (r < 4 || r > c) continue;
      if (Math.abs(fx) <= 2 || fy <= 2) continue; // the bright axis cross (picture edges, row/column structure) is not ranked
      var k = y * S + x, v = white[k], z = v / mad; if (z < zmin) continue;
      var isMax = true;
      for (var dy = -1; dy <= 1 && isMax; dy++) for (var dx = -1; dx <= 1; dx++) if ((dy || dx) && white[k + dy * S + dx] > v) { isMax = false; break; }
      if (!isMax) continue;
      out.push({ fx: fx, fy: fy, z: z, period: S / r, angle: Math.atan2(fy, fx) * 180 / Math.PI,
        label: (fx % (S / 8) === 0 && fy % (S / 8) === 0) ? '8-px grid' : '' });
    }
    out.sort(function (a, b) { return b.z - a.z; });
    return out.slice(0, K);
  }
  // difference view: logA - logB (log power ratio), whitened peaks of the ratio
  function compare(A, B) {
    var N = S * S, d = new Float32Array(N), dev = [];
    for (var i = 0; i < N; i++) { d[i] = A.logP[i] - B.logP[i]; }
    var mean = 0; for (i = 0; i < N; i++) mean += d[i]; mean /= N;
    var w = new Float32Array(N); for (i = 0; i < N; i++) { w[i] = d[i] - mean; dev.push(Math.abs(w[i])); }
    var mad = 1.4826 * median(dev) || 1e-9;
    return { diff: d, mean: mean, mad: mad, peaks: peaks(w, mad, 8, 6) };
  }
  var api = { S: S, SIGMA: SIGMA, cropOffset: cropOffset, accumulate: accumulate, finalize: finalize, compare: compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HPFinger = api;
})(typeof self !== 'undefined' ? self : this);

/* meter.js -- THE HIDDEN-PATTERN METER, ported to the browser (born Oct 14 2026).
 *
 * DETECTION ONLY. This file measures; it never removes, weakens or rewrites a pattern, and it never sends a byte
 * anywhere (no fetch, no XHR, no beacons, no imports: pure math on arrays it is handed).
 *
 * A port of two validated Python tools in the FABLEALIA repo (same math, same frozen thresholds):
 *   tools/hidden-pattern-scan.py v1.2 (md5 814e7ab8 at freeze) -- ONE image: 69 permutations x (full + 4 crops),
 *       windowed FFT, prominence = S / max(1, ray median, ring median, Nyquist-line median), labels, clusters,
 *       PATTERN > LATTICE > WEAK > CLEAN. T = 20.77, T_LATTICE = 23.8375 (frozen from 24 null images x 1.25).
 *   tools/model-mark-scan.py v1.1 (md5 e8db7960) -- MANY images of one size: phase coherence of the high-pass
 *       residual per FFT bin per channel, Rayleigh + Bonferroni, the shift null, the GRID blind band.
 *
 * DEVIATIONS FROM THE PYTHON (each one measured in Experiments/hidden-pattern-2026-10-01/page-test/):
 *   D1 (CLOSED Oct 14 2026, wave 4) the quantization-floor dither now draws from numpy's OWN generator: PCG64 seeded
 *      exactly as np.random.default_rng(1001) (its initial 128-bit state is a constant below) and numpy's buffered
 *      Lemire uint8 path, row block by row block like quant_dither(): the same draws, bit for bit. Needs BigInt; an
 *      engine without it falls back to mulberry32 (same distribution, different draws) and says so (DITHER_KIND).
 *   D2 hidden-pattern's Gaussian high-pass: the Python filters the reflect-padded plane in the FFT domain; here the
 *      SAME operator is applied as a circular convolution with its exact periodic kernel (computed by direct DFT),
 *      truncated at |d| > R (sigma 1: R = 128; sigma >= 2: R = 7 sigma + 2). Measured vs the Python on a 301x257 plane with a
 *      3.0 step: max |diff| 1.1e-6 (sigma 1), <= 2.2e-10 (sigma 2-8).
 *   D3 the autocorrelation confirmation (ac_z) is NOT computed: it never gated a verdict in the Python. The page
 *      shows the autocorrelation as a picture instead.
 *   D4 model-mark's shift null: the Python re-FFTs each circularly rolled residual; here the roll is applied as
 *      its exact phase ramp on the same spectrum (an identity). Roll offsets (CLOSED Oct 14 2026, wave 4) come from
 *      the same PCG64 as np.random.default_rng(1729).integers(0, H) / (0, W), numpy's scalar Lemire uint32 path:
 *      the Python's offsets exactly (opts.shifts still overrides; mulberry32 only without BigInt).
 *   D5 model-mark's per-bin unit-phase sums are accumulated in float32 (memory); C differs by ~1e-7.
 *   D6 images over the size cap are box-averaged down (the Python caps at 4096 px; the page defaults to 2048).
 *   D8 (Oct 14 2026, wave 4) a bin and its Hermitian mirror on the fy = -1/2 row tie EXACTLY here (one packed FFT) and
 *      by rounding noise in numpy; when both sit in one 5 x 5 window numpy keeps one of them as a local max and so
 *      does this file (the lower column index). Which one numpy keeps is rounding luck, and the two can carry different
 *      prominences. Such a pair sits within 1.5 bins of the (0, 1/2) or (1/2, 1/2) lattice point, so it is LABELLED
 *      (jpeg-grid, on an axis or a Nyquist line), not a candidate and not an off-axis lattice peak: no score or verdict
 *      depends on the choice (bar a refinement landing exactly on the 1.5-bin edge). Receipt: page-test-w4/.
 *   D7 decoding (decode.js, wave 4): PNGs are decoded by our own PNG reader (DecompressionStream + unfilter), byte for
 *      byte what PIL's convert("RGB") gives, colour under transparent pixels included. Other formats go through the
 *      browser (no colour management requested, EXIF rotation off, undone by hand where the engine ignores that); a
 *      browser JPEG decoder may differ from PIL's by a level here and there, and a canvas loses colour under alpha 0.
 */
(function (root) {
  'use strict';

  var T_FROZEN = 20.77;
  var T_LATTICE_FROZEN = 23.8375;
  var DC_BINS = 4.0, N_LOCALMAX = 150, PERIOD_TOL = 1.0, ANGLE_TOL = 3.0, MIN_CROP = 96;
  var QDITHER_SEED = 1001;

  // ------------------------------------------------------------------------------------------------ small helpers
  function roundHalfEven(x) {
    var f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }
  function pymod(a, n) { var r = a % n; return r < 0 ? r + n : r; }
  function fmod1f(x) { var r = x - Math.floor(x); return r; } // python float % 1.0
  var fr = Math.fround;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // numpy's PCG64 + its bounded-integer paths, bit for bit (D1/D4). BigInt is built with BigInt(), never a 1n literal,
  // so an engine without BigInt still PARSES this file and falls back to mulberry32.
  var HAS_BIGINT = typeof BigInt === 'function';
  var PCG_SEEDS = { // np.random.default_rng(seed).bit_generator.state (numpy 2.4.4; SeedSequence is stable across versions)
    1001: ['166110077734690349622093398695385059758', '75832438150325598680414078138474848963'],
    1729: ['260275080868705179941444768562716442507', '79125515514428683154904239957670779583']
  };
  var B = HAS_BIGINT ? {
    M64: (BigInt(1) << BigInt(64)) - BigInt(1), M128: (BigInt(1) << BigInt(128)) - BigInt(1),
    MULT: BigInt('0x2360ED051FC65DA44385DF649FCCF645'), S64: BigInt(64), S58: BigInt(58), S63: BigInt(63),
    S32: BigInt(32), M32: BigInt(0xffffffff)
  } : null;
  function PCG64(seed) {
    var st = PCG_SEEDS[seed];
    if (!st) throw new Error('no PCG64 state for seed ' + seed);
    this.s = BigInt(st[0]); this.inc = BigInt(st[1]); this.has = false; this.u = 0;
  }
  PCG64.prototype.next64 = function () { // XSL-RR 128/64, step then output (numpy pcg64)
    this.s = (this.s * B.MULT + this.inc) & B.M128;
    var hi = this.s >> B.S64, x = hi ^ (this.s & B.M64), rot = hi >> B.S58;
    return ((x >> rot) | (x << ((B.S64 - rot) & B.S63))) & B.M64;
  };
  PCG64.prototype.next32 = function () { // numpy pcg64_next32: low half first, the high half buffered
    if (this.has) { this.has = false; return this.u; }
    var n = this.next64();
    this.has = true; this.u = Number(n >> B.S32);
    return Number(n & B.M32);
  };
  // numpy random_bounded_uint8_fill (Lemire, buffered bytes; the byte buffer lives for ONE fill call)
  PCG64.prototype.fillU8 = function (out, off, cnt, rng) {
    var excl = rng + 1, thr = ((255 - rng) & 255) % excl, bcnt = 0, buf = 0, self = this;
    function b8() { if (!bcnt) { buf = self.next32(); bcnt = 3; } else { buf = buf >>> 8; bcnt--; } return buf & 255; }
    for (var i = 0; i < cnt; i++) {
      var m = (b8() * excl) & 0xffff, left = m & 255;
      if (left < excl) while (left < thr) { m = (b8() * excl) & 0xffff; left = m & 255; }
      out[off + i] = m >> 8;
    }
  };
  // numpy scalar Generator.integers(0, high) for high <= 2^32 (Lemire uint32, unbuffered)
  PCG64.prototype.intBelow = function (high) {
    var excl = BigInt(high), thr = BigInt((0xffffffff - (high - 1)) % high);
    var m = BigInt(this.next32()) * excl, left = m & B.M32;
    if (left < excl) while (left < thr) { m = BigInt(this.next32()) * excl; left = m & B.M32; }
    return Number(m >> B.S32);
  };
  // quickselect k-th smallest in a[lo..hi) (in place)
  function selectK(a, lo, hi, k) {
    hi = hi - 1;
    while (hi > lo) {
      var mid = (lo + hi) >> 1;
      // median of three
      var x = a[lo], y = a[mid], z = a[hi], piv;
      if (x < y) { piv = (y < z) ? y : (x < z ? z : x); } else { piv = (x < z) ? x : (y < z ? z : y); }
      var i = lo, j = hi;
      while (i <= j) {
        while (a[i] < piv) i++;
        while (a[j] > piv) j--;
        if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
    }
    return a[k];
  }
  // numpy median of buf[0..n) (destroys order)
  function medianInPlace(buf, n) {
    if (n === 0) return NaN;
    var h = n >> 1;
    if (n & 1) return selectK(buf, 0, n, h);
    var hi = selectK(buf, 0, n, h);
    var lo = -Infinity;
    for (var i = 0; i < h; i++) if (buf[i] > lo) lo = buf[i];
    return (lo + hi) / 2;
  }
  var _scratch = new Float64Array(1024);
  function scratch(n) { if (_scratch.length < n) _scratch = new Float64Array(n); return _scratch; }
  function medianOf(arr) { var n = arr.length, b = scratch(n); for (var i = 0; i < n; i++) b[i] = arr[i]; return medianInPlace(b, n); }

  // numpy.linspace(start, stop, num)
  function linspace(a, b, n) {
    var out = new Float64Array(n), step = (b - a) / (n - 1);
    for (var i = 0; i < n; i++) out[i] = i * step + a;
    out[n - 1] = b;
    return out;
  }

  // ------------------------------------------------------------------------------------------------ FFT (any length)
  var PLANS = new Map();
  function makePlan(n) {
    var p = PLANS.get(n);
    if (p) return p;
    var factors = [], m = n;
    while (m % 4 === 0) { factors.push(4); m /= 4; }
    while (m % 2 === 0) { factors.push(2); m /= 2; }
    for (var f = 3; f * f <= m; f += 2) while (m % f === 0) { factors.push(f); m /= f; }
    if (m > 1) factors.push(m);
    var maxf = 1;
    for (var i = 0; i < factors.length; i++) if (factors[i] > maxf) maxf = factors[i];
    p = { n: n, factors: factors, blue: null };
    if (maxf > 61 && n > 64) {
      p.blue = makeBluestein(n);
    } else {
      p.cos = new Float64Array(n); p.sin = new Float64Array(n);
      for (var k = 0; k < n; k++) { var a = -2 * Math.PI * k / n; p.cos[k] = Math.cos(a); p.sin[k] = Math.sin(a); }
      var mf = Math.max(maxf, 4);
      p.tr = new Float64Array(mf); p.ti = new Float64Array(mf);
    }
    p.xr = new Float64Array(n); p.xi = new Float64Array(n);
    PLANS.set(n, p);
    return p;
  }

  function rec(p, n, fi, xr, xi, xo, xs, yr, yi, yo, ts) {
    var f = p.factors[fi], m = n / f, C = p.cos, S = p.sin, q, j, k;
    if (m === 1) {
      if (f === 2) {
        var ar = xr[xo], ai = xi[xo], br = xr[xo + xs], bi = xi[xo + xs];
        yr[yo] = ar + br; yi[yo] = ai + bi; yr[yo + 1] = ar - br; yi[yo + 1] = ai - bi; return;
      }
      if (f === 4) {
        var a0r = xr[xo], a0i = xi[xo], a1r = xr[xo + xs], a1i = xi[xo + xs];
        var a2r = xr[xo + 2 * xs], a2i = xi[xo + 2 * xs], a3r = xr[xo + 3 * xs], a3i = xi[xo + 3 * xs];
        var s02r = a0r + a2r, s02i = a0i + a2i, d02r = a0r - a2r, d02i = a0i - a2i;
        var s13r = a1r + a3r, s13i = a1i + a3i, d13r = a1r - a3r, d13i = a1i - a3i;
        yr[yo] = s02r + s13r; yi[yo] = s02i + s13i;
        yr[yo + 1] = d02r + d13i; yi[yo + 1] = d02i - d13r;
        yr[yo + 2] = s02r - s13r; yi[yo + 2] = s02i - s13i;
        yr[yo + 3] = d02r - d13i; yi[yo + 3] = d02i + d13r;
        return;
      }
      for (j = 0; j < f; j++) {
        var sr = 0, si = 0;
        for (q = 0; q < f; q++) {
          var e = ((q * j) % f) * ts, cr = C[e], ci = S[e], vr = xr[xo + q * xs], vi = xi[xo + q * xs];
          sr += vr * cr - vi * ci; si += vr * ci + vi * cr;
        }
        yr[yo + j] = sr; yi[yo + j] = si;
      }
      return;
    }
    for (q = 0; q < f; q++) rec(p, m, fi + 1, xr, xi, xo + q * xs, xs * f, yr, yi, yo + q * m, ts * f);
    if (f === 2) {
      for (k = 0; k < m; k++) {
        var e2 = k * ts, wr = C[e2], wi = S[e2];
        var i0 = yo + k, i1 = i0 + m;
        var br2 = yr[i1] * wr - yi[i1] * wi, bi2 = yr[i1] * wi + yi[i1] * wr;
        var ar2 = yr[i0], ai2 = yi[i0];
        yr[i0] = ar2 + br2; yi[i0] = ai2 + bi2; yr[i1] = ar2 - br2; yi[i1] = ai2 - bi2;
      }
      return;
    }
    if (f === 4) {
      for (k = 0; k < m; k++) {
        var i00 = yo + k, i01 = i00 + m, i02 = i01 + m, i03 = i02 + m;
        var e1 = k * ts, e22 = 2 * k * ts, e3 = 3 * k * ts;
        var t0r = yr[i00], t0i = yi[i00];
        var t1r = yr[i01] * C[e1] - yi[i01] * S[e1], t1i = yr[i01] * S[e1] + yi[i01] * C[e1];
        var t2r = yr[i02] * C[e22] - yi[i02] * S[e22], t2i = yr[i02] * S[e22] + yi[i02] * C[e22];
        var t3r = yr[i03] * C[e3] - yi[i03] * S[e3], t3i = yr[i03] * S[e3] + yi[i03] * C[e3];
        var s02r2 = t0r + t2r, s02i2 = t0i + t2i, d02r2 = t0r - t2r, d02i2 = t0i - t2i;
        var s13r2 = t1r + t3r, s13i2 = t1i + t3i, d13r2 = t1r - t3r, d13i2 = t1i - t3i;
        yr[i00] = s02r2 + s13r2; yi[i00] = s02i2 + s13i2;
        yr[i01] = d02r2 + d13i2; yi[i01] = d02i2 - d13r2;
        yr[i02] = s02r2 - s13r2; yi[i02] = s02i2 - s13i2;
        yr[i03] = d02r2 - d13i2; yi[i03] = d02i2 + d13r2;
      }
      return;
    }
    var tr = p.tr, ti = p.ti;
    for (k = 0; k < m; k++) {
      for (q = 0; q < f; q++) {
        var idx = yo + q * m + k, e4 = q * k * ts;
        tr[q] = yr[idx] * C[e4] - yi[idx] * S[e4]; ti[q] = yr[idx] * S[e4] + yi[idx] * C[e4];
      }
      for (j = 0; j < f; j++) {
        var sr2 = 0, si2 = 0;
        for (q = 0; q < f; q++) {
          var e5 = ((q * j) % f) * m * ts;
          sr2 += tr[q] * C[e5] - ti[q] * S[e5]; si2 += tr[q] * S[e5] + ti[q] * C[e5];
        }
        yr[yo + j * m + k] = sr2; yi[yo + j * m + k] = si2;
      }
    }
  }

  function makeBluestein(n) {
    var M = 1; while (M < 2 * n - 1) M <<= 1;
    var P = makePlan(M);
    var wr = new Float64Array(n), wi = new Float64Array(n);
    for (var k = 0; k < n; k++) { var e = (k * k) % (2 * n), a = -Math.PI * e / n; wr[k] = Math.cos(a); wi[k] = Math.sin(a); }
    var Br = new Float64Array(M), Bi = new Float64Array(M);
    Br[0] = wr[0]; Bi[0] = -wi[0];
    for (var k2 = 1; k2 < n; k2++) { Br[k2] = wr[k2]; Bi[k2] = -wi[k2]; Br[M - k2] = wr[k2]; Bi[M - k2] = -wi[k2]; }
    fftInPlace(Br, Bi, M);
    return { M: M, P: P, wr: wr, wi: wi, Br: Br, Bi: Bi, ar: new Float64Array(M), ai: new Float64Array(M) };
  }

  // forward DFT of re/im (length n, contiguous), in place.
  function fftInPlace(re, im, n) {
    if (n === 1) return;
    var p = makePlan(n);
    if (p.blue) {
      var b = p.blue, M = b.M, ar = b.ar, ai = b.ai, k;
      for (k = 0; k < n; k++) { ar[k] = re[k] * b.wr[k] - im[k] * b.wi[k]; ai[k] = re[k] * b.wi[k] + im[k] * b.wr[k]; }
      for (k = n; k < M; k++) { ar[k] = 0; ai[k] = 0; }
      fftInPlace(ar, ai, M);
      for (k = 0; k < M; k++) {
        var xr = ar[k] * b.Br[k] - ai[k] * b.Bi[k], xi = ar[k] * b.Bi[k] + ai[k] * b.Br[k];
        ar[k] = xr; ai[k] = -xi; // conj for inverse
      }
      fftInPlace(ar, ai, M);
      for (k = 0; k < n; k++) {
        var cr = ar[k] / M, ci = -ai[k] / M;
        re[k] = cr * b.wr[k] - ci * b.wi[k]; im[k] = cr * b.wi[k] + ci * b.wr[k];
      }
      return;
    }
    var xr2 = p.xr, xi2 = p.xi;
    xr2.set(re.length === n ? re : re.subarray(0, n)); xi2.set(im.length === n ? im : im.subarray(0, n));
    rec(p, n, 0, xr2, xi2, 0, 1, re, im, 0, 1);
  }

  var _col = { r: new Float64Array(0), i: new Float64Array(0) };
  // 2-D forward FFT of row-major H x W complex arrays, in place.
  function fft2(re, im, H, W) {
    var y, x, rr, ri;
    if (W > 1) {
      for (y = 0; y < H; y++) {
        rr = re.subarray(y * W, y * W + W); ri = im.subarray(y * W, y * W + W);
        fftInPlace(rr, ri, W);
      }
    }
    if (H > 1) {
      if (_col.r.length < H) { _col.r = new Float64Array(H); _col.i = new Float64Array(H); }
      var cr = _col.r.subarray(0, H), ci = _col.i.subarray(0, H);
      for (x = 0; x < W; x++) {
        for (y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; }
        fftInPlace(cr, ci, H);
        for (y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; }
      }
    }
  }
  function ifft2(re, im, H, W) {
    var n = H * W, i;
    for (i = 0; i < n; i++) im[i] = -im[i];
    fft2(re, im, H, W);
    for (i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }

  // ------------------------------------------------------------------------------------------------ colour (per pixel)
  var M_RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
  var M_XYZ2RGB = inv3(M_RGB2XYZ);
  var WHITE = [0.95047, 1.0, 1.08883];
  var EPS_LAB = 216.0 / 24389.0, KAP = 24389.0 / 27.0;
  function inv3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function l2s(c) { if (c < 0) c = 0; return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  var LABOUT = new Float64Array(3), RGBOUT = new Float64Array(3), HSVOUT = new Float64Array(3);
  function rgbToLab(r, g, b) {
    var lr = s2l(r), lg = s2l(g), lb = s2l(b), M = M_RGB2XYZ;
    var X = (lr * M[0] + lg * M[1] + lb * M[2]) / WHITE[0];
    var Y = (lr * M[3] + lg * M[4] + lb * M[5]) / WHITE[1];
    var Z = (lr * M[6] + lg * M[7] + lb * M[8]) / WHITE[2];
    var fx = X > EPS_LAB ? Math.cbrt(X) : (KAP * X + 16) / 116;
    var fy = Y > EPS_LAB ? Math.cbrt(Y) : (KAP * Y + 16) / 116;
    var fz = Z > EPS_LAB ? Math.cbrt(Z) : (KAP * Z + 16) / 116;
    LABOUT[0] = 116 * fy - 16; LABOUT[1] = 500 * (fx - fy); LABOUT[2] = 200 * (fy - fz);
    return LABOUT;
  }
  function finv(t) { var t3 = t * t * t; return t3 > EPS_LAB ? t3 : (116 * t - 16) / KAP; }
  function labToRgb(L, a, b) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    var X = finv(fx) * WHITE[0];
    var Y = (L > KAP * EPS_LAB ? fy * fy * fy : L / KAP) * WHITE[1];
    var Z = finv(fz) * WHITE[2], M = M_XYZ2RGB;
    RGBOUT[0] = l2s(X * M[0] + Y * M[1] + Z * M[2]);
    RGBOUT[1] = l2s(X * M[3] + Y * M[4] + Z * M[5]);
    RGBOUT[2] = l2s(X * M[6] + Y * M[7] + Z * M[8]);
    return RGBOUT;
  }
  function rgbToHsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var s = mx > 0 ? d / Math.max(mx, 1e-12) : 0;
    var dd = Math.max(d, 1e-12), rc = (mx - r) / dd, gc = (mx - g) / dd, bc = (mx - b) / dd, h;
    if (r === mx) h = bc - gc; else if (g === mx) h = 2 + rc - bc; else h = 4 + gc - rc;
    h = d > 1e-12 ? fmod1f(h / 6) : 0;
    HSVOUT[0] = h; HSVOUT[1] = s; HSVOUT[2] = mx;
    return HSVOUT;
  }
  function hsvToRgb(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    i = pymod(i, 6);
    var r, g, b;
    switch (i) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q;
    }
    RGBOUT[0] = r; RGBOUT[1] = g; RGBOUT[2] = b;
    return RGBOUT;
  }
  function clip01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // ------------------------------------------------------------------------------------------------ the 69 permutations
  var PERMS = [];
  (function () {
    var C = 'RGB', i, k, r;
    for (i = 0; i < 3; i++) PERMS.push(['colour', 'RGB:' + C[i]]);
    ['HSV:H', 'HSV:S', 'HSV:V', 'LAB:L', 'LAB:a', 'LAB:b', 'YCbCr:Y', 'YCbCr:Cb', 'YCbCr:Cr'].forEach(function (n) { PERMS.push(['colour', n]); });
    [2, 5, 20, 50].forEach(function (kk) { PERMS.push(['satboost', 'satHSVx' + kk + ':R-G']); PERMS.push(['satboost', 'satHSVx' + kk + ':Y-B']); });
    [2, 5, 20, 50].forEach(function (kk) { PERMS.push(['satboost', 'satLABx' + kk + ':R-G']); PERMS.push(['satboost', 'satLABx' + kk + ':Y-B']); });
    for (i = 0; i < 3; i++) PERMS.push(['stretch', 'stretch:' + C[i]]);
    for (i = 0; i < 3; i++) PERMS.push(['stretch', 'equalize:' + C[i]]);
    [1, 2, 4, 8].forEach(function (rr) { ['R', 'G', 'B', 'a', 'b'].forEach(function (cn) { PERMS.push(['highpass', 'hp' + rr + ':' + cn]); }); });
    for (i = 0; i < 3; i++) PERMS.push(['medres', 'medres:' + C[i]]);
    for (i = 0; i < 3; i++) for (k = 0; k < 4; k++) PERMS.push(['bitplane', 'bit' + k + ':' + C[i]]);
  })();

  // img = {rgb: Uint8Array(H*W*3), H, W}
  function channelHist(img, c) {
    var h = new Float64Array(256), n = img.H * img.W, d = img.rgb;
    for (var i = 0; i < n; i++) h[d[3 * i + c]]++;
    return h;
  }
  function percentileFromHist(hist, n, q) {
    var pos = q / 100 * (n - 1), lo = Math.floor(pos), fr2 = pos - lo;
    function kth(k) { var acc = 0; for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc > k) return v; } return 255; }
    var a = kth(lo), b = (fr2 > 0) ? kth(Math.min(lo + 1, n - 1)) : a;
    return a + (b - a) * fr2;
  }

  // circular-conv Gaussian high-pass kernel (deviation D2)
  var KCACHE = new Map();
  function gaussKernel(N, sigma) {
    var key = N + ':' + sigma, k = KCACHE.get(key);
    if (k) return k;
    var R = sigma <= 1 ? 128 : Math.ceil(7 * sigma) + 2;
    if (2 * R + 1 > N) R = Math.floor((N - 1) / 2);
    var G = new Float64Array(N), cosT = new Float64Array(N), j;
    for (j = 0; j < N; j++) {
      var f = ((j <= Math.floor((N - 1) / 2)) ? j : j - N) * (1.0 / N);
      G[j] = Math.exp(-2.0 * Math.PI * Math.PI * sigma * sigma * f * f);
      cosT[j] = Math.cos(2 * Math.PI * j / N);
    }
    var ker = new Float64Array(R + 1);
    for (var d = 0; d <= R; d++) {
      var s = 0;
      for (j = 0; j < N; j++) s += G[j] * cosT[(j * d) % N];
      ker[d] = s / N;
    }
    k = { R: R, ker: ker, full: (2 * R + 1 >= N - 1) };
    if (KCACHE.size > 64) KCACHE.clear();
    KCACHE.set(key, k);
    return k;
  }
  function reflectIndex(i, n) { // numpy 'reflect' padding index
    if (n === 1) return 0;
    var period = 2 * (n - 1);
    i = pymod(i, period);
    return i < n ? i : period - i;
  }
  // python gauss_blur(x, sigma): reflect pad p, circular filter on the padded plane, crop
  function gaussBlur(x, H, W, sigma) {
    var p = Math.ceil(3 * sigma) + 1;
    p = Math.min(p, H - 1, W - 1);
    var Hp = H + 2 * p, Wp = W + 2 * p, y, xx, d;
    var kx = gaussKernel(Wp, sigma), ky = gaussKernel(Hp, sigma);
    // pass 1: horizontal on every padded row (interior columns only). ext = the padded row, wrapped circularly by R
    // on both sides, so the inner loop has no modulo.
    var tmp = new Float64Array(Hp * W), Rx = kx.R, K = kx.ker, ext = new Float64Array(Wp + 2 * Rx);
    for (y = 0; y < Hp; y++) {
      var sy = reflectIndex(y - p, H) * W;
      for (xx = 0; xx < Wp + 2 * Rx; xx++) ext[xx] = x[sy + reflectIndex(pymod(xx - Rx, Wp) - p, W)];
      for (xx = 0; xx < W; xx++) {
        var c = xx + p + Rx, s = K[0] * ext[c];
        for (d = 1; d <= Rx; d++) s += K[d] * (ext[c - d] + ext[c + d]);
        tmp[y * W + xx] = s;
      }
    }
    var out = new Float64Array(H * W), Ry = ky.R, KY = ky.ker, col = new Float64Array(Hp + 2 * Ry);
    for (xx = 0; xx < W; xx++) {
      for (y = 0; y < Hp + 2 * Ry; y++) col[y] = tmp[pymod(y - Ry, Hp) * W + xx];
      for (y = 0; y < H; y++) {
        var cy = y + p + Ry, s2 = KY[0] * col[cy];
        for (d = 1; d <= Ry; d++) s2 += KY[d] * (col[cy - d] + col[cy + d]);
        out[y * W + xx] = s2;
      }
    }
    return out;
  }
  function median3(img, c) { // PIL MedianFilter(3), edge-replicated
    var H = img.H, W = img.W, d = img.rgb, out = new Uint8Array(H * W), w9 = new Float64Array(9);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var n = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy; yy = yy < 0 ? 0 : (yy >= H ? H - 1 : yy);
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx; xx = xx < 0 ? 0 : (xx >= W ? W - 1 : xx);
          w9[n++] = d[3 * (yy * W + xx) + c];
        }
      }
      out[y * W + x] = selectK(w9, 0, 9, 4);
    }
    return out;
  }

  // -> {map: Float32Array(H*W), view: Uint8ClampedArray RGBA or null}
  function computePerm(img, name, wantView) {
    var H = img.H, W = img.W, n = H * W, d = img.rgb, out = new Float32Array(n), i, view = null, v;
    var ci = { R: 0, G: 1, B: 2 };
    var mm;
    if ((mm = /^RGB:([RGB])$/.exec(name))) { var c = ci[mm[1]]; for (i = 0; i < n; i++) out[i] = d[3 * i + c] / 255.0; return { map: out }; }
    if ((mm = /^HSV:([HSV])$/.exec(name))) {
      var hi = 'HSV'.indexOf(mm[1]);
      for (i = 0; i < n; i++) { v = rgbToHsv(d[3 * i] / 255.0, d[3 * i + 1] / 255.0, d[3 * i + 2] / 255.0); out[i] = v[hi]; }
      return { map: out };
    }
    if ((mm = /^LAB:([Lab])$/.exec(name))) {
      var li = 'Lab'.indexOf(mm[1]);
      for (i = 0; i < n; i++) { v = rgbToLab(d[3 * i] / 255.0, d[3 * i + 1] / 255.0, d[3 * i + 2] / 255.0); out[i] = v[li]; }
      return { map: out };
    }
    if ((mm = /^YCbCr:(Y|Cb|Cr)$/.exec(name))) {
      for (i = 0; i < n; i++) {
        var r = d[3 * i], g = d[3 * i + 1], b = d[3 * i + 2];
        out[i] = mm[1] === 'Y' ? 0.299 * r + 0.587 * g + 0.114 * b :
          mm[1] === 'Cb' ? 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b : 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      return { map: out };
    }
    if ((mm = /^sat(HSV|LAB)x(\d+):(R-G|Y-B)$/.exec(name))) {
      var k = +mm[2], rg = mm[3] === 'R-G';
      if (wantView) view = new Uint8ClampedArray(n * 4);
      for (i = 0; i < n; i++) {
        var R0 = d[3 * i] / 255.0, G0 = d[3 * i + 1] / 255.0, B0 = d[3 * i + 2] / 255.0, vr, vg, vb;
        if (mm[1] === 'HSV') { v = rgbToHsv(R0, G0, B0); v = hsvToRgb(v[0], clip01(v[1] * k), v[2]); }
        else { v = rgbToLab(R0, G0, B0); v = labToRgb(v[0], v[1] * k, v[2] * k); }
        vr = clip01(v[0]); vg = clip01(v[1]); vb = clip01(v[2]);
        out[i] = rg ? vr - vg : 0.5 * (vr + vg) - vb;
        if (view) { view[4 * i] = vr * 255; view[4 * i + 1] = vg * 255; view[4 * i + 2] = vb * 255; view[4 * i + 3] = 255; }
      }
      return { map: out, view: view };
    }
    if ((mm = /^stretch:([RGB])$/.exec(name))) {
      var c2 = ci[mm[1]], hist = channelHist(img, c2);
      var a = fr(percentileFromHist(hist, n, 0.5)), bb = fr(percentileFromHist(hist, n, 99.5));
      if (fr(bb - a) < 1e-12) return { map: out };
      var den = fr(bb - a);
      for (i = 0; i < n; i++) out[i] = clip01(fr(fr(d[3 * i + c2] - a) / den));
      return { map: out };
    }
    if ((mm = /^equalize:([RGB])$/.exec(name))) {
      var c3 = ci[mm[1]], h3 = channelHist(img, c3), cdf = new Float64Array(256), acc = 0, cmin = 0, j;
      for (j = 0; j < 256; j++) { acc += h3[j]; cdf[j] = acc; }
      for (j = 0; j < 256; j++) if (cdf[j] > 0) { cmin = cdf[j]; break; }
      if (n === cmin) return { map: out };
      var lut = new Float32Array(256);
      for (j = 0; j < 256; j++) lut[j] = (cdf[j] - cmin) / (n - cmin);
      for (i = 0; i < n; i++) out[i] = lut[d[3 * i + c3]];
      return { map: out };
    }
    if ((mm = /^hp(\d):([RGBab])$/.exec(name))) {
      var sig = +mm[1], ch = new Float64Array(n);
      if (mm[2] === 'a' || mm[2] === 'b') {
        var lab = mm[2] === 'a' ? 1 : 2;
        for (i = 0; i < n; i++) { v = rgbToLab(d[3 * i] / 255.0, d[3 * i + 1] / 255.0, d[3 * i + 2] / 255.0); ch[i] = v[lab]; }
      } else { var c4 = ci[mm[2]]; for (i = 0; i < n; i++) ch[i] = d[3 * i + c4] / 255.0; }
      var bl = gaussBlur(ch, H, W, sig);
      for (i = 0; i < n; i++) out[i] = ch[i] - bl[i];
      return { map: out };
    }
    if ((mm = /^medres:([RGB])$/.exec(name))) {
      var c5 = ci[mm[1]], med = median3(img, c5);
      for (i = 0; i < n; i++) out[i] = d[3 * i + c5] - med[i];
      return { map: out };
    }
    if ((mm = /^bit(\d):([RGB])$/.exec(name))) {
      var kb = +mm[1], c6 = ci[mm[2]];
      for (i = 0; i < n; i++) out[i] = (d[3 * i + c6] >> kb) & 1;
      return { map: out };
    }
    throw new Error('unknown permutation ' + name);
  }

  // u8 + d, d in {-1,0,+1}, P(+-1) = 1/24: hidden-pattern-scan quant_dither(), the SAME draws (D1): numpy's
  // rng.integers(0, 24, size=block, dtype=uint8), one fill per row block of max(1, 2^22 // (W*3)) rows.
  var DITHER_KIND = HAS_BIGINT ? 'numpy-pcg64' : 'mulberry32';
  function quantDither(img, seed) {
    var d = img.rgb, n = d.length, out = new Uint8Array(n), k = new Uint8Array(n), i;
    if (HAS_BIGINT) {
      var g = new PCG64(seed == null ? QDITHER_SEED : seed), row = img.W * 3, step = Math.max(1, Math.floor(4194304 / Math.max(1, row)));
      for (var y0 = 0; y0 < img.H; y0 += step) {
        var rows = Math.min(step, img.H - y0);
        g.fillU8(k, y0 * row, rows * row, 23);
      }
    } else {
      var rnd = mulberry32(seed == null ? QDITHER_SEED : seed);
      for (i = 0; i < n; i++) k[i] = Math.floor(rnd() * 24);
    }
    for (i = 0; i < n; i++) {
      var v = d[i] + (k[i] === 0 ? 1 : (k[i] === 1 ? -1 : 0));
      out[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return { rgb: out, H: img.H, W: img.W };
  }

  // ------------------------------------------------------------------------------------------------ regions
  function smoothSize(n) {
    while (n > 1) {
      var m = n;
      while (m % 2 === 0) m /= 2; while (m % 3 === 0) m /= 3; while (m % 5 === 0) m /= 5;
      if (m === 1) return n;
      n -= 1;
    }
    return n;
  }
  function makeRegions(H, W, ncrops) {
    if (ncrops == null) ncrops = 4;
    var regs = [['full', 0, 0, H, W]];
    var rows = Math.max(1, Math.floor(Math.sqrt(ncrops))), cols = Math.ceil(ncrops / rows);
    var ch = Math.floor(H / rows), cw = Math.floor(W / cols);
    if (ch < MIN_CROP || cw < MIN_CROP) throw new Error('image ' + W + 'x' + H + ' too small for ' + ncrops + ' disjoint crops of >= ' + MIN_CROP + ' px');
    for (var i = 0; i < ncrops; i++) { var r = Math.floor(i / cols), c = i % cols; regs.push(['crop' + i, r * ch, c * cw, ch, cw]); }
    return regs;
  }
  function trimRegion(m, W, y0, x0, rh, rw) { // python trim(m[y0:y0+rh, x0:x0+rw])
    var th = smoothSize(rh), tw = smoothSize(rw), oy = Math.floor((rh - th) / 2), ox = Math.floor((rw - tw) / 2);
    var out = new Float32Array(th * tw);
    for (var y = 0; y < th; y++) { var s = (y0 + oy + y) * W + x0 + ox; out.set(m.subarray(s, s + tw), y * tw); }
    return { a: out, h: th, w: tw };
  }

  // ------------------------------------------------------------------------------------------------ geometry
  var GEO = new Map();
  // numpy.fft.fftfreq exactly: integer * (1.0/n) (NOT integer / n: the last ulp decides which annulus an edge bin joins)
  function fftfreq(n) { var f = new Float64Array(n), h = Math.floor((n - 1) / 2), val = 1.0 / n; for (var i = 0; i < n; i++) f[i] = (i <= h ? i : i - n) * val; return f; }
  function geometry(h, w) {
    var key = h + 'x' + w, g = GEO.get(key);
    if (g) return g;
    g = { h: h, w: w };
    var fy1 = fftfreq(h), fx1 = fftfreq(w), n = h * w, y, x, i;
    g.fy1 = fy1; g.fx1 = fx1;
    g.df = 1.0 / Math.min(h, w);
    var kbin = new Float64Array(n), kmax = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var kb = Math.sqrt(fx1[x] * fx1[x] + fy1[y] * fy1[y]) / g.df;
      kbin[y * w + x] = kb; if (kb > kmax) kmax = kb;
    }
    var edges = [];
    for (i = 0; i <= 50; i++) edges.push(i);
    var e = 50.0; kmax += 1.0;
    while (edges[edges.length - 1] < kmax) { e *= 1.02; edges.push(Math.max(edges[edges.length - 1] + 1, roundHalfEven(e))); }
    var nann = edges.length, ann = new Int32Array(n);
    for (i = 0; i < n; i++) { // searchsorted(edges, k, 'right') - 1
      var k = kbin[i], lo = 0, hi = nann;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (edges[mid] <= k) lo = mid + 1; else hi = mid; }
      ann[i] = lo - 1;
    }
    var counts = new Int32Array(nann);
    for (i = 0; i < n; i++) counts[ann[i]]++;
    var starts = new Int32Array(nann + 1);
    for (i = 0; i < nann; i++) starts[i + 1] = starts[i] + counts[i];
    var fill = starts.slice(0, nann), order = new Int32Array(n);
    for (i = 0; i < n; i++) order[fill[ann[i]]++] = i;
    g.ann = ann; g.nann = nann; g.starts = starts; g.order = order; g.counts = counts;
    var wy = new Float64Array(h), wx = new Float64Array(w);
    // np.hanning(M)[:-1] with M = side + 1 (periodic Hann), numpy's own formula: 0.5 + 0.5 cos(pi n / (M-1)), n = 1-M, 3-M, ...
    for (y = 0; y < h; y++) wy[y] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - (h + 1) + 2 * y) / h);
    for (x = 0; x < w; x++) wx[x] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - (w + 1) + 2 * x) / w);
    var win = new Float64Array(n), dc = new Uint8Array(n), half = new Uint8Array(n), win2 = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      win[i] = wy[y] * wx[x]; win2 += win[i] * win[i];
      dc[i] = kbin[i] < DC_BINS ? 1 : 0;
      var fy = fy1[y], fx = fx1[x];
      half[i] = ((fy > 0) || (fy === -0.5) || ((fy === 0) && ((fx > 0) || (fx === -0.5)))) ? 1 : 0;
    }
    g.win = win; g.win2 = win2; g.dc = dc; g.half = half; g.kbin = kbin;
    if (GEO.size > 12) GEO.clear();
    GEO.set(key, g);
    return g;
  }

  function annulusMedians(A, g) {
    var nann = g.nann, med = new Float64Array(nann), buf = scratch(A.length), any = false, i, j;
    for (i = 0; i < nann; i++) {
      var s0 = g.starts[i], s1 = g.starts[i + 1];
      if (s1 > s0) { for (j = s0; j < s1; j++) buf[j - s0] = A[g.order[j]]; med[i] = medianInPlace(buf, s1 - s0); any = true; }
      else med[i] = NaN;
    }
    if (!any) return null;
    // np.interp over the empty annuli
    var good = [];
    for (i = 0; i < nann; i++) if (!isNaN(med[i])) good.push(i);
    var out = new Float64Array(nann);
    for (i = 0; i < nann; i++) {
      if (!isNaN(med[i])) { out[i] = med[i]; continue; }
      if (i <= good[0]) { out[i] = med[good[0]]; continue; }
      if (i >= good[good.length - 1]) { out[i] = med[good[good.length - 1]]; continue; }
      var lo = 0; while (good[lo + 1] < i) lo++;
      var a = good[lo], b = good[lo + 1];
      out[i] = med[a] + (med[b] - med[a]) * (i - a) / (b - a);
    }
    return out;
  }

  var RING = (function () { var o = []; for (var dy = -7; dy <= 7; dy++) for (var dx = -7; dx <= 7; dx++) { var d = Math.hypot(dy, dx); if (d >= 3.5 && d <= 7.0) o.push([dy, dx]); } return o; })();
  var SC = (function () { var a = linspace(0.55, 0.85, 7), b = linspace(1.18, 1.6, 9), o = new Float64Array(16); o.set(a, 0); o.set(b, 7); return o; })();

  function nearMultiple(v, step, tol) { var k = roundHalfEven(v / step); return Math.abs(v - k * step) <= tol; }
  function latticePoint(fx, fy, h, w) {
    var tx = 1.0 / w, ty = 1.0 / h, Ls = [8, 16];
    for (var i = 0; i < 2; i++) {
      var L = Ls[i];
      if (nearMultiple(fx, 1.0 / L, 1.5 * tx) && nearMultiple(fy, 1.0 / L, 1.5 * ty)) return [L, roundHalfEven(fx * L), roundHalfEven(fy * L)];
    }
    return null;
  }
  function latticeOffaxis(lp) { if (!lp) return false; var L = lp[0], kx = lp[1], ky = lp[2]; return kx !== 0 && ky !== 0 && Math.abs(kx) * 2 !== L && Math.abs(ky) * 2 !== L; }
  function labelPeak(fx, fy, h, w) {
    var tx = 1.0 / w, ty = 1.0 / h, lp = latticePoint(fx, fy, h, w);
    if (lp) return ['jpeg-grid', 'block-lattice-1/' + lp[0]];
    var onX = Math.abs(fy) <= ty, onY = Math.abs(fx) <= tx;
    if (onX || onY) {
      var comp = onX ? Math.abs(fx) : Math.abs(fy), tol = 1.5 * (onX ? tx : ty), qs = [7, 6, 5, 4, 3];
      for (var i = 0; i < 5; i++) if (nearMultiple(comp, 1.0 / qs[i], tol)) return ['jpeg-grid', 'resize-grid-1/' + qs[i]];
      return ['axis', 'axis'];
    }
    return ['candidate', ''];
  }

  // ------------------------------------------------------------------------------------------------ THE METER
  // m, qn: Float32Array (h*w). Returns {flat, peaks:[...], A?, S?}
  function analyze(m, qn, h, w, keep) {
    var g = geometry(h, w), n = h * w, i, mean = 0, maxabs = 0;
    for (i = 0; i < n; i++) { mean += m[i]; var am = Math.abs(m[i]); if (am > maxabs) maxabs = am; }
    mean /= n;
    var re = new Float64Array(n), im = new Float64Array(n), ss = 0;
    for (i = 0; i < n; i++) { var xv = m[i] - mean; ss += xv * xv; re[i] = xv; }
    var sd = Math.sqrt(ss / n);
    if (sd <= 1e-9 * Math.max(maxabs, 1e-12) || sd === 0) return { flat: true, peaks: [] };
    var useQ = false, qmean = 0, qmax = 0;
    if (qn) {
      for (i = 0; i < n; i++) qmean += qn[i];
      qmean /= n;
      for (i = 0; i < n; i++) { var t = Math.abs(qn[i] - qmean); if (t > qmax) qmax = t; }
      useQ = qmax > 0;
    }
    for (i = 0; i < n; i++) { re[i] *= g.win[i]; im[i] = useQ ? (qn[i] - qmean) * g.win[i] : 0; }
    fft2(re, im, h, w);
    var A = new Float64Array(n), QA = useQ ? new Float64Array(n) : null, y, x;
    for (y = 0; y < h; y++) {
      var ny = (h - y) % h;
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!useQ) { A[i] = Math.hypot(re[i], im[i]); continue; }
        var j = ny * w + (w - x) % w;
        var ar = 0.5 * (re[i] + re[j]), ai = 0.5 * (im[i] - im[j]);   // (F[k] + conj F[-k]) / 2
        var br = 0.5 * (im[i] + im[j]), bi = -0.5 * (re[i] - re[j]);  // (F[k] - conj F[-k]) / 2i
        A[i] = Math.hypot(ar, ai); QA[i] = Math.hypot(br, bi);
      }
    }
    var med = annulusMedians(A, g);
    if (!med) return { flat: true, peaks: [] };
    var nann = g.nann, qmed = null, qhow = 'none', bound = null, nbound = 0;
    if (qn) {
      if (useQ) {
        var qm = annulusMedians(QA, g), qmx = 0;
        if (qm) for (i = 0; i < nann; i++) if (qm[i] > qmx) qmx = qm[i];
        if (qm && qmx > 0) { qmed = qm; qhow = 'dither'; }
      }
      if (!qmed) {
        var srt = Float32Array.from(m).sort(), step = Infinity, uniq = 1;
        for (i = 1; i < n; i++) if (srt[i] !== srt[i - 1]) { uniq++; var dd = fr(srt[i] - srt[i - 1]); if (dd < step) step = dd; }
        if (uniq < 2) { qhow = 'flat'; }
        else {
          var lvl = (step / Math.sqrt(12.0)) * Math.sqrt(g.win2 * Math.log(2.0));
          qmed = new Float64Array(nann).fill(lvl); qhow = 'white-step';
        }
      }
    }
    if (qmed) {
      bound = new Uint8Array(nann);
      for (i = 0; i < nann; i++) { if (qmed[i] > med[i]) { bound[i] = 1; if (i >= DC_BINS) nbound++; med[i] = qmed[i]; } }
    }
    var amax = 0;
    for (i = 0; i < n; i++) if (A[i] > amax) amax = A[i];
    var floor = Math.max(amax * 1e-9, 1e-300);
    var S = new Float64Array(n), Sm = new Float64Array(n);
    for (i = 0; i < n; i++) { var bg = med[g.ann[i]]; if (bg < floor) bg = floor; S[i] = A[i] / bg; Sm[i] = (g.dc[i] || !g.half[i]) ? 0 : S[i]; }
    // 5x5 circular max (python _rollmax: axis 0 then axis 1)
    var RM = new Float64Array(Sm), base = new Float64Array(n), dd2;
    base.set(RM);
    for (y = 0; y < h; y++) for (dd2 = 1; dd2 <= 2; dd2++) {
      var ya = pymod(y - dd2, h) * w, yb = pymod(y + dd2, h) * w, yo = y * w;
      for (x = 0; x < w; x++) { var v1 = base[ya + x], v2 = base[yb + x]; if (v1 > RM[yo + x]) RM[yo + x] = v1; if (v2 > RM[yo + x]) RM[yo + x] = v2; }
    }
    base.set(RM);
    for (y = 0; y < h; y++) { var ro = y * w; for (x = 0; x < w; x++) for (dd2 = 1; dd2 <= 2; dd2++) { var u1 = base[ro + pymod(x - dd2, w)], u2 = base[ro + pymod(x + dd2, w)]; if (u1 > RM[ro + x]) RM[ro + x] = u1; if (u2 > RM[ro + x]) RM[ro + x] = u2; } }
    var cand = [], isC = new Uint8Array(n);
    for (i = 0; i < n; i++) if (Sm[i] > 0 && Sm[i] >= RM[i]) isC[i] = 1;
    // THE NYQUIST-ROW MIRROR TIE (found Oct 14 2026, wave 4: page_vs_cli.py, a real RGBA render, HSV:V crop1). With the
    // two-real-FFTs-in-one packing above, a bin and its Hermitian mirror on the fy = -1/2 row (both in the half-plane)
    // get EXACTLY equal S. Within one 5 x 5 window both then pass ">= the window max" and take two of the 150 slots;
    // numpy computes the two separately, they differ by rounding, and only ONE is a local max. Keep one, like numpy
    // does (which one numpy keeps is decided by rounding noise; both carry the same prominence by symmetry).
    if (h % 2 === 0) {
      var yN = h / 2, ro2 = yN * w;
      for (x = 0; x < w; x++) {
        var a1 = ro2 + x, xm2 = (w - x) % w, a2 = ro2 + xm2;
        if (!isC[a1] || xm2 === x || !isC[a2] || Sm[a1] !== Sm[a2]) continue;
        var cd = Math.abs(x - xm2); cd = Math.min(cd, w - cd);
        if (cd <= 2 && x > xm2) isC[a1] = 0;
      }
    }
    for (i = 0; i < n; i++) if (isC[i]) cand.push(i);
    var res = { flat: false, peaks: [], qfloor: qhow, qfloor_bound_frac: Math.round(nbound / Math.max(1, nann - DC_BINS) * 1000) / 1000 };
    if (keep) { res.A = A; res.S = S; }
    if (!cand.length) return res;
    cand.sort(function (a, b) { return Sm[b] - Sm[a]; });
    var top = cand.slice(0, N_LOCALMAX), peaks = [];
    var fxs = g.fx1, fys = g.fy1;
    function lA(idx) { return Math.log(A[idx] + floor); }
    for (var t2 = 0; t2 < top.length; t2++) {
      var fi = top[t2], iy = Math.floor(fi / w), ix = fi - iy * w;
      var c0 = lA(fi), xm = lA(iy * w + pymod(ix - 1, w)), xp = lA(iy * w + pymod(ix + 1, w));
      var ym = lA(pymod(iy - 1, h) * w + ix), yp = lA(pymod(iy + 1, h) * w + ix);
      var den = xm - 2 * c0 + xp, dx = den < 0 ? 0.5 * (xm - xp) / den : 0.0;
      den = ym - 2 * c0 + yp;
      var dy = den < 0 ? 0.5 * (ym - yp) / den : 0.0;
      dx = Math.min(0.5, Math.max(-0.5, dx)); dy = Math.min(0.5, Math.max(-0.5, dy));
      var fxr = (fxs[ix] * w + dx) / w, fyr = (fys[iy] * h + dy) / h, fmag = Math.hypot(fxr, fyr);
      if (fmag <= 0) continue;
      var ux = fxr / fmag, uy = fyr / fmag, samp = [];
      for (var tt = -1; tt <= 1; tt++) for (var si = 0; si < 16; si++) {
        var sfx = fxr * SC[si] + (-uy) * tt / w, sfy = fyr * SC[si] + ux * tt / h;
        if (!(Math.abs(sfx) < 0.5 && Math.abs(sfy) < 0.5)) continue;
        var jx = pymod(roundHalfEven(sfx * w), w), jy = pymod(roundHalfEven(sfy * h), h), jj = jy * w + jx;
        if (!g.dc[jj]) samp.push(S[jj]);
      }
      var rayMed = samp.length >= 4 ? medianOf(samp) : 1.0;
      var rs = [];
      for (var ri = 0; ri < RING.length; ri++) { var rj = pymod(iy + RING[ri][0], h) * w + pymod(ix + RING[ri][1], w); if (!g.dc[rj]) rs.push(S[rj]); }
      var ringMed = rs.length >= 8 ? medianOf(rs) : 1.0;
      var rowv = [], colv = [], hw = Math.floor(w / 2), hh = Math.floor(h / 2), q2;
      for (q2 = 0; q2 < w; q2++) if (Math.abs(pymod(q2 - ix + hw, w) - hw) > 3 && !g.dc[iy * w + q2]) rowv.push(S[iy * w + q2]);
      for (q2 = 0; q2 < h; q2++) if (Math.abs(pymod(q2 - iy + hh, h) - hh) > 3 && !g.dc[q2 * w + ix]) colv.push(S[q2 * w + ix]);
      var rowMed = rowv.length >= 8 ? medianOf(rowv) : 1.0, colMed = colv.length >= 8 ? medianOf(colv) : 1.0;
      var nyqX = Math.abs(Math.abs(fxr) - 0.5) * w <= 1.5, nyqY = Math.abs(Math.abs(fyr) - 0.5) * h <= 1.5;
      var nyqMed = Math.max(nyqX ? colMed : 0.0, nyqY ? rowMed : 0.0);
      var sAnn = S[fi], prom = sAnn / Math.max(1.0, rayMed, ringMed, nyqMed);
      var lab = labelPeak(fxr, fyr, h, w);
      peaks.push({
        iy: iy, ix: ix, period_px: 1.0 / fmag, angle_deg: pymod(Math.atan2(fyr, fxr) * 180 / Math.PI, 180.0),
        prominence: prom, S_annulus: sAnn, ray_med: rayMed, ring_med: ringMed, line_med: Math.max(rowMed, colMed),
        fx: fxr, fy: fyr, label: lab[0], label_why: lab[1],
        lattice_offaxis: lab[0] === 'jpeg-grid' && lab[1].indexOf('block-lattice') === 0 && latticeOffaxis(latticePoint(fxr, fyr, h, w)),
        qfloor_bound: !!(bound && bound[g.ann[fi]])
      });
    }
    // stable sort by -prominence, then NMS 2.5 bins
    peaks = peaks.map(function (p, k) { return [p, k]; }).sort(function (a, b) { return (b[0].prominence - a[0].prominence) || (a[1] - b[1]); }).map(function (a) { return a[0]; });
    var kept = [];
    for (var pi = 0; pi < peaks.length; pi++) {
      var p = peaks[pi], ok = true;
      for (var qi = 0; qi < kept.length; qi++) if (Math.hypot(p.iy - kept[qi].iy, p.ix - kept[qi].ix) <= 2.5) { ok = false; break; }
      if (ok) kept.push(p);
    }
    res.peaks = kept;
    return res;
  }

  // one permutation over all regions. img/dimg = {rgb,H,W}. Returns the decide() input + summary.
  function scanPerm(img, dimg, name, opts) {
    opts = opts || {};
    var fam = null;
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i][1] === name) fam = PERMS[i][0];
    var pm = computePerm(img, name, !!opts.wantView), qm = computePerm(dimg, name, false);
    var m = pm.map, n = m.length, qn = new Float32Array(n);
    for (i = 0; i < n; i++) qn[i] = qm.map[i] - m[i];
    if (name === 'HSV:H') for (i = 0; i < n; i++) { var t = fr(qn[i] + 0.5); t = fr(t - Math.floor(t)); qn[i] = fr(t - 0.5); }
    var regs = makeRegions(img.H, img.W, opts.ncrops == null ? 4 : opts.ncrops), out = { name: name, family: fam, regions: {} };
    var fullRes = null;
    for (var r = 0; r < regs.length; r++) {
      var R = regs[r], sub = trimRegion(m, img.W, R[1], R[2], R[3], R[4]), qs = trimRegion(qn, img.W, R[1], R[2], R[3], R[4]);
      var keep = !!opts.keepSpectrum && R[0] === 'full';
      var res = analyze(sub.a, qs.a, sub.h, sub.w, keep);
      var cands = [], labelled = [];
      for (var k = 0; k < res.peaks.length; k++) {
        var p = res.peaks[k];
        if (p.label === 'candidate') cands.push([p.period_px, p.angle_deg, p.prominence]);
        else labelled.push([p.label, p.period_px, p.angle_deg, p.prominence, p.label_why, p.lattice_offaxis]);
      }
      out.regions[R[0]] = { shape: [sub.h, sub.w], flat: res.flat, qfloor: res.qfloor, cands: cands, labelled: labelled,
        top: res.peaks.slice(0, 8).map(function (p) { return { period_px: p.period_px, angle_deg: p.angle_deg, prominence: p.prominence, label: p.label, ix: p.ix, iy: p.iy }; }) };
      if (keep) fullRes = { res: res, h: sub.h, w: sub.w, map: sub.a };
    }
    out.score = permScore(out);
    if (opts.keepSpectrum) out._full = fullRes;
    if (opts.wantView) out._map = pm;
    return out;
  }

  // the page's sort key for one transform (MY definition, not in the Python): the larger of
  //   max candidate prominence / T  and  max off-axis lattice prominence / T_LATTICE, over all regions.
  function permScore(perm, T, Tl) {
    T = T || T_FROZEN; Tl = Tl || T_LATTICE_FROZEN;
    var bc = 0, bl = 0, where = null, lwhere = null;
    for (var rn in perm.regions) {
      var r = perm.regions[rn], k;
      for (k = 0; k < r.cands.length; k++) if (r.cands[k][2] > bc) { bc = r.cands[k][2]; where = [rn, r.cands[k][0], r.cands[k][1]]; }
      for (k = 0; k < r.labelled.length; k++) if (r.labelled[k][5] && r.labelled[k][3] > bl) { bl = r.labelled[k][3]; lwhere = [rn, r.labelled[k][1], r.labelled[k][2]]; }
    }
    return { cand: bc, cand_where: where, lattice: bl, lattice_where: lwhere, score: Math.max(bc / T, bl / Tl) };
  }

  function angdiff(a, b) { var d = pymod(Math.abs(a - b), 180.0); return Math.min(d, 180.0 - d); }
  function median(arr) { return medianOf(arr); }
  function cluster(hits) {
    var clusters = [], sorted = hits.slice().map(function (h, k) { return [h, k]; }).sort(function (a, b) { return (b[0].prominence - a[0].prominence) || (a[1] - b[1]); });
    sorted.forEach(function (pair) {
      var hh = pair[0];
      for (var i = 0; i < clusters.length; i++) {
        var c = clusters[i];
        if (Math.abs(hh.period_px - c.seed_period) <= PERIOD_TOL && angdiff(hh.angle_deg, c.seed_angle) <= ANGLE_TOL) { c.members.push(hh); return; }
      }
      clusters.push({ seed_period: hh.period_px, seed_angle: hh.angle_deg, members: [hh] });
    });
    return clusters.map(function (c) {
      var perms = {}, crops = {}, regions = {};
      c.members.forEach(function (m) { perms[m.perm] = 1; regions[m.region] = 1; if (m.region !== 'full') crops[m.region] = 1; });
      var Ps = c.members.map(function (m) { return m.period_px; });
      var un = c.members.map(function (m) { return c.seed_angle + (pymod(m.angle_deg - c.seed_angle + 90, 180) - 90); });
      var np_ = Object.keys(perms).sort(), nc = Object.keys(crops).sort();
      return {
        period_px: median(Ps), angle_deg: pymod(median(un), 180.0), seed_period_px: c.seed_period, seed_angle_deg: c.seed_angle,
        max_prominence: Math.max.apply(null, c.members.map(function (m) { return m.prominence; })),
        n_hits: c.members.length, n_permutations: np_.length, n_crops: nc.length, permutations: np_, crops: nc,
        regions: Object.keys(regions).sort(), recurs: np_.length >= 2 && nc.length >= 2
      };
    });
  }

  // python decide(scan, T, T_lat): perms = [{name, regions:{rname:{cands, labelled}}}]
  function decide(perms, T, Tlat) {
    if (T === undefined) T = T_FROZEN;
    if (T !== null && Tlat == null) Tlat = Math.max(T, T_LATTICE_FROZEN);
    var bestC = 0, bestCW = null, bestL = 0, bestLW = null, hits = [], lat = [], axisGe = 0, gridGe = 0;
    perms.forEach(function (p) {
      Object.keys(p.regions).forEach(function (rn) {
        var r = p.regions[rn];
        r.cands.forEach(function (c) {
          if (c[2] > bestC) { bestC = c[2]; bestCW = [p.name, rn, c[0], c[1]]; }
          if (T !== null && c[2] >= T) hits.push({ perm: p.name, region: rn, period_px: c[0], angle_deg: c[1], prominence: c[2] });
        });
        r.labelled.forEach(function (l) {
          var lab = l[0], P = l[1], ang = l[2], prom = l[3], off = l[5];
          if (off && prom > bestL) { bestL = prom; bestLW = [p.name, rn, P, ang]; }
          if (T !== null && prom >= T) { if (lab === 'axis') axisGe++; else gridGe++; }
          if (T !== null && off && prom >= Tlat) lat.push({ perm: p.name, region: rn, period_px: P, angle_deg: ang, prominence: prom });
        });
      });
    });
    var cl = cluster(hits), lcl = cluster(lat);
    cl.forEach(function (c) {
      var best = null;
      cl.forEach(function (d) {
        if (d === c || d.period_px <= c.period_px * 1.5) return;
        if (angdiff(c.angle_deg, d.angle_deg) > ANGLE_TOL) return;
        var ratio = d.period_px / c.period_px, nn = Math.round(ratio);
        if (nn >= 2 && nn <= 32 && Math.abs(ratio - nn) <= 0.02 * nn) if (!best || d.period_px > best[0].period_px) best = [d, nn];
      });
      if (best) c.harmonic_of = { period_px: best[0].period_px, angle_deg: best[0].angle_deg, n: best[1], fundamental_recurs: best[0].recurs, fundamental_max_prominence: best[0].max_prominence };
    });
    var sortC = function (a, b) { return ((a.recurs ? 0 : 1) - (b.recurs ? 0 : 1)) || (b.max_prominence - a.max_prominence); };
    cl.sort(sortC); lcl.sort(sortC);
    var verdict = null;
    if (T !== null) {
      if (cl.some(function (c) { return c.recurs; })) verdict = 'PATTERN';
      else if (lcl.some(function (c) { return c.recurs; })) verdict = 'LATTICE';
      else if (hits.length) verdict = 'WEAK';
      else verdict = 'CLEAN';
    }
    return { verdict: verdict, T: T, T_lattice: Tlat, n_hits: hits.length, clusters: cl.slice(0, 20), n_clusters: cl.length,
      max_candidate_prominence: bestC, max_candidate_where: bestCW, axis_peaks_ge_T: axisGe, grid_peaks_ge_T: gridGe,
      lattice_offaxis_ge_T: lat.length, lattice_clusters: lcl.slice(0, 10), n_lattice_clusters: lcl.length,
      max_offaxis_lattice_prominence: bestL, max_offaxis_lattice_where: bestLW };
  }

  // ------------------------------------------------------------------------------------------------ display helpers
  function stretchToU8(a, lo, hi, step) {
    var n = a.length, s = [], st = step || Math.max(1, Math.floor(n / 200000));
    for (var i = 0; i < n; i += st) s.push(a[i]);
    s.sort(function (x, y) { return x - y; });
    function pct(q) { var pos = q / 100 * (s.length - 1), l = Math.floor(pos), f = pos - l; return s[l] + ((s[Math.min(l + 1, s.length - 1)] - s[l]) * f); }
    var A = pct(lo), B = pct(hi), out = new Uint8ClampedArray(n);
    if (B - A < 1e-12) return out;
    for (var j = 0; j < n; j++) out[j] = Math.max(0, Math.min(1, (a[j] - A) / (B - A))) * 255;
    return out;
  }
  // fftshift(log1p(A)) for display; returns Float64Array h*w
  function shiftedLog(A, h, w) {
    var out = new Float64Array(h * w), sy = Math.floor(h / 2), sx = Math.floor(w / 2);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) out[((y + sy) % h) * w + ((x + sx) % w)] = Math.log1p(A[y * w + x]);
    return out;
  }
  // whitened autocorrelation AC = IFFT(S^2), DC disk zeroed, normalised, fftshifted
  function autocorr(S, h, w) {
    var g = geometry(h, w), n = h * w, re = new Float64Array(n), im = new Float64Array(n), i;
    for (i = 0; i < n; i++) re[i] = g.dc[i] ? 0 : S[i] * S[i];
    ifft2(re, im, h, w);
    var a0 = re[0] || 1, out = new Float64Array(n), sy = Math.floor(h / 2), sx = Math.floor(w / 2);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) out[((y + sy) % h) * w + ((x + sx) % w)] = re[y * w + x] / a0;
    out[sy * w + sx] = 0; // the zero lag is 1 by construction; blank it so the rest shows
    return out;
  }

  // ------------------------------------------------------------------------------------------------ MULTI-IMAGE: coherence
  var COEF = { R: [1, 0, 0], G: [0, 1, 0], B: [0, 0, 1], Y: [0.299, 0.587, 0.114], Cb: [-0.168736, -0.331264, 0.5], Cr: [0.5, -0.418688, -0.081312] };
  var CH_ALL = ['R', 'G', 'B', 'Y', 'Cb', 'Cr'];
  var COH_SIGMA = 1.5, COH_RING = 2.0, COH_EPS = 1e-6, DIV_WARN_RES = 0.5, DIV_WARN_RAW = 0.6;
  var GK = (function () { var r = Math.ceil(4 * COH_SIGMA), k = [], s = 0, i; for (i = -r; i <= r; i++) { var v = Math.exp(-0.5 * (i / COH_SIGMA) * (i / COH_SIGMA)); k.push(v); s += v; } return { r: r, k: k.map(function (v) { return v / s; }) }; })();
  function blur13(a, H, W) { // model-mark blur(): separable, reflect edges, same summation order
    var R = GK.r, K = GK.k, tmp = new Float64Array(H * W), out = new Float64Array(H * W), y, x, j;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var s = K[R] * a[y * W + x];
      for (j = 1; j <= R; j++) s += (a[reflectIndex(y + j, H) * W + x] + a[reflectIndex(y - j, H) * W + x]) * K[R + j];
      tmp[y * W + x] = s;
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var s2 = K[R] * tmp[y * W + x];
      for (j = 1; j <= R; j++) s2 += (tmp[y * W + reflectIndex(x + j, W)] + tmp[y * W + reflectIndex(x - j, W)]) * K[R + j];
      out[y * W + x] = s2;
    }
    return out;
  }

  function Coh(H, W, channels, opts) {
    opts = opts || {};
    this.H = H; this.W = W; this.Wh = Math.floor(W / 2) + 1; this.channels = channels || CH_ALL.slice();
    var sseed = opts.shiftSeed == null ? 1729 : opts.shiftSeed;
    this.N = 0; this.pcg = (HAS_BIGINT && PCG_SEEDS[sseed]) ? new PCG64(sseed) : null; this.rnd = mulberry32(sseed); this.shifts = opts.shifts || null;
    var nb = H * this.Wh, self = this;
    this.U = {}; this.S = {};
    this.channels.forEach(function (c) { self.U[c] = { r: new Float32Array(nb), i: new Float32Array(nb) }; self.S[c] = { r: new Float32Array(nb), i: new Float32Array(nb) }; });
    this.divS = { res: new Float64Array(3 * H * W), raw: new Float64Array(3 * H * W) };
    this.divV = { res: 0, raw: 0 };
    this.zero = 0;
  }
  Coh.prototype.feed = function (rgb, w, h) { // rgb Uint8Array H*W*3 (+ its own W, H when the caller knows them)
    var H = this.H, W = this.W, Wh = this.Wh, n = H * W, c, i, y, x;
    // model-mark refuses a size mismatch (exit 3); a swapped W x H has the same byte count, so the dims are checked too
    if (!rgb || rgb.length !== n * 3 || (w != null && (w !== W || h !== H)))
      throw new Error('picture ' + (w != null ? w + ' x ' + h : (rgb ? rgb.length / 3 + ' px' : 'missing')) + ' does not match the set size ' + W + ' x ' + H + ' (never resized)');
    var planes = [], raws = [];
    for (c = 0; c < 3; c++) {
      var p = new Float64Array(n);
      for (i = 0; i < n; i++) p[i] = rgb[3 * i + c];
      raws.push(p);
      var b = blur13(p, H, W), r = new Float64Array(n);
      for (i = 0; i < n; i++) r[i] = p[i] - b[i];
      planes.push(r);
    }
    // diversity
    for (var key in { res: 1, raw: 1 }) {
      var src = key === 'res' ? planes : raws, vs = 0;
      for (c = 0; c < 3; c++) {
        var s = 0, s2 = 0, off = c * n, arr = src[c], acc = this.divS[key];
        for (i = 0; i < n; i++) { var v = arr[i]; s += v; acc[off + i] += v; }
        var mu = s / n;
        for (i = 0; i < n; i++) { var dv = arr[i] - mu; s2 += dv * dv; }
        vs += s2 / n;
      }
      this.divV[key] += vs / 3;
    }
    // spectra: pack R+iG, B alone
    var re = new Float64Array(n), im = new Float64Array(n);
    re.set(planes[0]); im.set(planes[1]); fft2(re, im, H, W);
    var re2 = new Float64Array(n), im2 = new Float64Array(n);
    re2.set(planes[2]); fft2(re2, im2, H, W);
    var dy, dx;
    if (this.shifts) { var sh = this.shifts[this.N]; dy = sh[0]; dx = sh[1]; }
    else if (this.pcg) { do { dy = this.pcg.intBelow(H); dx = this.pcg.intBelow(W); } while (!dy && !dx); } // model-mark Coh.feed
    else { do { dy = Math.floor(this.rnd() * H); dx = Math.floor(this.rnd() * W); } while (!dy && !dx); }
    var self = this, Fr = new Float64Array(3), Fi = new Float64Array(3);
    for (y = 0; y < H; y++) {
      var ny = (H - y) % H, py = dy * y / H;
      for (x = 0; x < Wh; x++) {
        i = y * W + x; var j = ny * W + (W - x) % W;
        Fr[0] = 0.5 * (re[i] + re[j]); Fi[0] = 0.5 * (im[i] - im[j]);
        Fr[1] = 0.5 * (im[i] + im[j]); Fi[1] = -0.5 * (re[i] - re[j]);
        Fr[2] = re2[i]; Fi[2] = im2[i];
        var ph = -2 * Math.PI * (py + dx * x / W), cr = Math.cos(ph), ci = Math.sin(ph), bi = y * Wh + x;
        for (var k = 0; k < self.channels.length; k++) {
          var cf = COEF[self.channels[k]], gr = cf[0] * Fr[0] + cf[1] * Fr[1] + cf[2] * Fr[2], gi = cf[0] * Fi[0] + cf[1] * Fi[1] + cf[2] * Fi[2];
          var mag = Math.hypot(gr, gi);
          if (mag <= COH_EPS) { self.zero++; continue; }
          var ur = gr / mag, ui = gi / mag, U = self.U[self.channels[k]], Sx = self.S[self.channels[k]];
          U.r[bi] += ur; U.i[bi] += ui;
          Sx.r[bi] += ur * cr - ui * ci; Sx.i[bi] += ur * ci + ui * cr;
        }
      }
    }
    this.N++;
  };
  Coh.prototype.diversity = function () {
    var N = this.N, H = this.H, W = this.W, n = H * W, d = { N: N, independent_expectation: N ? 1 / Math.sqrt(N) : null };
    for (var key in { res: 1, raw: 1 }) {
      var vsingle = this.divV[key] / Math.max(N, 1), vm = 0, acc = this.divS[key];
      for (var c = 0; c < 3; c++) {
        var s = 0, s2 = 0, off = c * n, i;
        for (i = 0; i < n; i++) s += acc[off + i] / Math.max(N, 1);
        var mu = s / n;
        for (i = 0; i < n; i++) { var v = acc[off + i] / Math.max(N, 1) - mu; s2 += v * v; }
        vm += s2 / n;
      }
      vm /= 3;
      d['rho_' + key] = vsingle > 0 ? Math.sqrt(vm / vsingle) : 0;
    }
    var fl = 2 / Math.sqrt(Math.max(N, 1));
    d.warn = N >= 4 ? (d.rho_res >= Math.max(DIV_WARN_RES, fl) || d.rho_raw >= Math.max(DIV_WARN_RAW, fl)) : false;
    d.thresholds = { res: Math.max(DIV_WARN_RES, fl), raw: Math.max(DIV_WARN_RAW, fl) };
    return d;
  };
  Coh.prototype.evaluate = function (alpha) {
    alpha = alpha || 0.01;
    var H = this.H, W = this.W, Wh = this.Wh, N = this.N, nb = H * Wh, y, x, i, self = this;
    var valid = new Uint8Array(nb), grid = new Uint8Array(nb), canon = new Uint8Array(nb), nvalid = 0, ngridvalid = 0;
    var sy = H / 16, sx = W / 16, FY = new Int32Array(nb), FX = new Int32Array(nb);
    for (y = 0; y < H; y++) {
      var fy = y <= Math.floor(H / 2) ? y : y - H;
      for (x = 0; x < Wh; x++) {
        i = y * Wh + x; FY[i] = fy; FX[i] = x;
        valid[i] = Math.sqrt(fy * fy + x * x) > COH_RING ? 1 : 0;
        var ny_ = Math.abs(fy - roundHalfEven(fy / sy) * sy) <= 1 + 1e-9, nx_ = Math.abs(x - roundHalfEven(x / sx) * sx) <= 1 + 1e-9;
        grid[i] = (ny_ || nx_) ? 1 : 0;
        canon[i] = ((x === 0 || (W % 2 === 0 && x === W / 2)) && y > Math.floor(H / 2)) ? 0 : 1;
        if (valid[i]) { nvalid++; if (grid[i]) ngridvalid++; }
      }
    }
    var nch = this.channels.length, tests = nch * nvalid, apt = alpha / tests;
    var cstar = Math.sqrt(Math.log(1 / apt) / N);
    var ev = { N: N, H: H, W: W, tests: tests, alpha: alpha, cstar: cstar, counts: {}, bins: [], grid_blind_fraction: ngridvalid / nvalid };
    var anyA = new Uint8Array(nb), anyS = new Uint8Array(nb), anyG = new Uint8Array(nb), anyGA = new Uint8Array(nb);
    var Cmax = new Float32Array(nb), clsMax = new Uint8Array(nb);
    this.channels.forEach(function (ch) {
      var U = self.U[ch], S = self.S[ch], cnt = { anchored_offgrid: 0, shared_offgrid: 0, grid: 0, grid_anchored: 0, grid_shared: 0 };
      for (i = 0; i < nb; i++) {
        if (!valid[i]) continue;
        var C = fr(Math.hypot(U.r[i], U.i[i]) / N), Cs = fr(Math.hypot(S.r[i], S.i[i]) / N);
        if (C > Cmax[i]) Cmax[i] = C;
        var sig = Math.exp(-N * C * C) < apt, sigs = Math.exp(-N * Cs * Cs) < apt;
        if (!sig) continue;
        var cls = grid[i] ? 3 : (sigs ? 2 : 1);
        if (canon[i]) {
          if (cls === 1) { cnt.anchored_offgrid++; anyA[i] = 1; ev.bins.push({ ch: ch, fy: FY[i], fx: FX[i], C: C, Cs: Cs, period_px: 1 / Math.hypot(FY[i] / H, FX[i] / W), angle_deg: Math.atan2(FY[i] / H, FX[i] / W) * 180 / Math.PI }); }
          else if (cls === 2) { cnt.shared_offgrid++; anyS[i] = 1; }
          else { cnt.grid++; anyG[i] = 1; if (sigs) cnt.grid_shared++; else { cnt.grid_anchored++; anyGA[i] = 1; } }
        }
        if (cls === 1) clsMax[i] = 1; else if (cls === 3 && clsMax[i] !== 1) clsMax[i] = 3; else if (cls === 2 && !clsMax[i]) clsMax[i] = 2;
      }
      ev.counts[ch] = cnt;
    });
    function cnt1(a) { var s = 0; for (var k = 0; k < nb; k++) s += a[k]; return s; }
    ev.n_anch = cnt1(anyA); ev.n_shared = cnt1(anyS); ev.n_grid = cnt1(anyG); ev.n_grid_anchored = cnt1(anyGA);
    ev.diversity = this.diversity();
    ev.underpowered = cstar >= 1.0;
    ev.n_min = Math.floor(Math.log(1 / apt)) + 1;
    ev.verdict = ev.n_anch > 0 ? 'ANCHORED-CARRIERS(' + ev.n_anch + ')' : (ev.n_grid > 0 ? 'GRID-ONLY' : 'NONE');
    ev.bins.sort(function (a, b) { return b.C - a.C; });
    ev._Cmax = Cmax; ev._cls = clsMax; ev.Wh = Wh;
    return ev;
  };

  var api = {
    VERSION: 'meter.js 1.1 (port of hidden-pattern-scan v1.2 + model-mark-scan v1.1; numpy PCG64 draws)',
    DITHER_KIND: DITHER_KIND, PCG64: HAS_BIGINT ? PCG64 : null,
    T_FROZEN: T_FROZEN, T_LATTICE_FROZEN: T_LATTICE_FROZEN, PERMS: PERMS, N_PERMUTATIONS: PERMS.length,
    fft2: fft2, ifft2: ifft2, fftInPlace: fftInPlace, computePerm: computePerm, quantDither: quantDither,
    makeRegions: makeRegions, analyze: analyze, scanPerm: scanPerm, permScore: permScore, decide: decide,
    geometry: geometry, stretchToU8: stretchToU8, shiftedLog: shiftedLog, autocorr: autocorr,
    Coh: Coh, CH_ALL: CH_ALL, gaussBlur: gaussBlur, blur13: blur13, roundHalfEven: roundHalfEven, smoothSize: smoothSize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HPMeter = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));

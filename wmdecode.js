/* wmdecode.js -- read the open "invisible-watermark" DWT-DCT mark (born Oct 17 2026).
 *
 * DETECTION ONLY, no network. A faithful port of the DECODER in invisible-watermark 0.2.0 (imwatermark/maxDct.py,
 * method 'dwtDct', the one Stable Diffusion's reference scripts and Stability's sgm/SDXL code call):
 *   BGR -> YUV (OpenCV 8-bit), channel U only (scales [0, 36, 36], loop range(2)), crop to a multiple of 4,
 *   one-level Haar DWT -> cA, 4 x 4 blocks of cA in raster order, block k carries bit (k mod L):
 *   the largest |value| among the block's 15 non-first samples, bit = (|v| mod 36) > 18; each bit's score is the mean
 *   over its blocks; bit = mean > 0.5. Equivalence with the Python decoder: tools/harness/ (RESULTS.md).
 * The payload length L is not stored in the image, so we read the two published payloads' lengths:
 *   136 bits  "StableDiffusionV1" as UTF-8 bytes (CompVis / Stability SD 1.x-2.x scripts)
 *   48 bits   0xB3EC907BB19E (Stability generative-models, sgm/inference/helpers.py WATERMARK_MESSAGE, SDXL)
 * and say how many bits match each, with the chance of matching that many by luck (binomial, one-sided).
 * NOTE: despite the method's name, maxDct.py's encode_frame/decode_frame pass the RAW cA block to
 * diffuse_dct_matrix / infer_dct_matrix (cv2.dct is only used by the unused *_svd variants), so there is no DCT here
 * either: porting the library as written, not as named, is what makes the bits agree.
 * Exposes self.HPWm (and module.exports for node).
 */
(function (root) {
  'use strict';
  var SCALE = 36, BLOCK = 4;
  function bytesToBits(str) { var out = []; for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); for (var b = 7; b >= 0; b--) out.push((c >> b) & 1); } return out; }
  function hexToBits(hex) { var out = []; for (var i = 0; i < hex.length; i++) { var v = parseInt(hex[i], 16); for (var b = 3; b >= 0; b--) out.push((v >> b) & 1); } return out; }
  var KNOWN = [
    { id: 'sd1', name: 'Stable Diffusion 1.x / 2.x scripts: "StableDiffusionV1"', bits: bytesToBits('StableDiffusionV1') },
    { id: 'sdxl', name: 'Stability generative-models (SDXL): 0xB3EC907BB19E', bits: hexToBits('B3EC907BB19E') }
  ];
  // OpenCV cvtColor(BGR2YUV) for 8-bit: Y = .299R + .587G + .114B, U = .492(B - Y) + 128, V = .877(R - Y) + 128, rounded
  // in fixed point (14 bits) and saturated. Only U is used.
  var YR = 4899, YG = 9617, YB = 1868, UC = 8061, SH = 14, HALF = 1 << 13;
  function uPlane(rgb, H, W) {
    var u = new Float64Array(H * W);
    for (var i = 0; i < H * W; i++) {
      var r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
      var y = (r * YR + g * YG + b * YB + HALF) >> SH;
      var v = ((b - y) * UC + HALF + (128 << SH)) >> SH;
      u[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    return u;
  }
  // per-bit mean scores for payload length L
  function scores(rgb, H, W, lens) {
    var u = uPlane(rgb, H, W), R4 = (H >> 2) << 2, C4 = (W >> 2) << 2, ch = R4 >> 1, cw = C4 >> 1, ca = new Float64Array(ch * cw), i, j;
    // pywt.dwt2(.., 'haar') in its own floating-point order (axis 0, then axis 1; each output = h * x[2k+1] + h * x[2k],
    // h = 0.7071067811865476). The plain (a + b + c + d) / 2 is the same in exact maths but not in doubles, and the
    // bit rule (|v| mod 36 > 18) sits exactly on half-integers like 18.0, so the rounding decides bits.
    var HH = 0.7071067811865476, vt = new Float64Array(ch * C4);
    for (i = 0; i < ch; i++) for (j = 0; j < C4; j++) { var t1 = HH * u[(2 * i + 1) * W + j]; vt[i * C4 + j] = t1 + HH * u[2 * i * W + j]; }
    for (i = 0; i < ch; i++) for (j = 0; j < cw; j++) { var t2 = HH * vt[i * C4 + 2 * j + 1]; ca[i * cw + j] = t2 + HH * vt[i * C4 + 2 * j]; }
    var nbr = Math.floor(ch / BLOCK), nbc = Math.floor(cw / BLOCK), nblk = nbr * nbc, bitsOf = new Uint8Array(nblk), blk = new Float64Array(16), k = 0;
    for (var bi = 0; bi < nbr; bi++) for (var bj = 0; bj < nbc; bj++) {
      var p, q;
      for (p = 0; p < 4; p++) for (q = 0; q < 4; q++) blk[4 * p + q] = ca[(bi * 4 + p) * cw + bj * 4 + q];
      var best = -1, pos = 1;
      for (p = 1; p < 16; p++) { var av = Math.abs(blk[p]); if (av > best) { best = av; pos = p; } }   // numpy argmax: first max
      bitsOf[k++] = (best % SCALE) > 0.5 * SCALE ? 1 : 0;
    }
    return lens.map(function (L) {
      var sum = new Float64Array(L), cnt = new Float64Array(L);
      for (var m = 0; m < nblk; m++) { sum[m % L] += bitsOf[m]; cnt[m % L]++; }
      var mean = [], bits = [];
      for (var b = 0; b < L; b++) { var v = cnt[b] ? sum[b] / cnt[b] : 0; mean.push(v); bits.push(v * 255 > 127 ? 1 : 0); }
      return { L: L, bits: bits, mean: mean, blocks: nblk };
    });
  }
  function logChoose(n, k) { var s = 0; for (var i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
  function binomTail(n, k) { // P(X >= k), X ~ Bin(n, 1/2)
    var p = 0; for (var j = k; j <= n; j++) p += Math.exp(logChoose(n, j) - n * Math.LN2); return Math.min(1, p);
  }
  function bitsToText(bits) { var s = ''; for (var i = 0; i + 7 < bits.length; i += 8) { var c = 0; for (var b = 0; b < 8; b++) c = (c << 1) | bits[i + b]; s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '\u00b7'; } return s; }
  function bitsToHex(bits) { var s = ''; for (var i = 0; i + 3 < bits.length; i += 4) s += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16).toUpperCase(); return s; }
  // read: {known: [{id, name, L, match, p, bits, text|hex}], verdict, blocks}
  function read(rgb, H, W) {
    if (Math.min(H, W) < 32) return { error: 'too small for the DWT-DCT reader (needs 32 px)' };
    var res = scores(rgb, H, W, KNOWN.map(function (k) { return k.bits.length; }));
    var known = KNOWN.map(function (k, idx) {
      var r = res[idx], m = 0;
      for (var b = 0; b < r.L; b++) if (r.bits[b] === k.bits[b]) m++;
      return { id: k.id, name: k.name, L: r.L, match: m, p: binomTail(r.L, m), bits: r.bits.join(''), text: k.id === 'sd1' ? bitsToText(r.bits) : null, hex: bitsToHex(r.bits), blocks_per_bit: r.blocks / r.L };
    });
    var hit = known.filter(function (k) { return k.p < 1e-6; });
    return { known: known, blocks: res[0].blocks, verdict: hit.length ? 'MATCH:' + hit.map(function (h) { return h.id; }).join('+') : 'NO-MATCH' };
  }
  var api = { read: read, scores: scores, KNOWN: KNOWN, binomTail: binomTail, VERSION: 'wmdecode.js 1.0 (invisible-watermark 0.2.0 dwtDct decoder port)' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HPWm = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));

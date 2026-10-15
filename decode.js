/* decode.js -- read a picture's pixels the way the command-line scanner does (born Oct 14 2026, wave 4).
 *
 * No network: everything here works on bytes the page already holds (File.arrayBuffer()). DecompressionStream is a
 * local zlib inflater, not a request. Exposes self.HPDecode (and module.exports for the bun test harness).
 *
 * WHY: tools/hidden-pattern-scan.py reads a file with PIL: Image.open(path).convert("RGB"). That
 *   - keeps the colour stored UNDER transparent pixels (convert drops the alpha channel, it does not composite),
 *   - ignores the EXIF orientation tag (the pixels are analysed as stored in the file),
 *   - ignores colour profiles (iCCP / gAMA / sRGB chunks).
 * A browser canvas does none of that by default: it premultiplies alpha (colour under alpha 0 is lost), and engines
 * differ on whether createImageBitmap honours imageOrientation 'none'. So:
 *   decodePNG()  our own PNG reader: IHDR/PLTE/IDAT, zlib via DecompressionStream('deflate'), the five scanline filters,
 *                Adam7 interlace, every colour type and bit depth -> RGB exactly as PIL's convert("RGB"), receipts in
 *                Experiments/hidden-pattern-2026-10-01/page-test-w4/ (PIL quirks kept on purpose: 16-bit colour keeps
 *                the HIGH byte; 16-bit grey CLIPS at 255, PIL mode "I"; palette entries past PLTE read black).
 *   sniff()      PNG/JPEG headers: stored size, colour type, alpha, the JPEG EXIF orientation tag (0x0112).
 *   undoOrientation()  turns a browser-rotated decode back into the stored orientation (EXIF 2-8).
 *   PROBE_JPEG   a 16 x 8 JPEG tagged orientation 6: decoding it tells us whether THIS engine applied the tag.
 */
(function (root) {
  'use strict';

  function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  function isPNG(b) { for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false; return true; }
  function isJPEG(b) { return b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; }

  // ------------------------------------------------------------------------------------------------ PNG chunks
  function pngChunks(b, lenient) { // lenient: a header-only slice of the file (stop at the first chunk that runs past it)
    var o = 8, out = { ihdr: null, plte: null, trns: null, idat: [], idatLen: 0 };
    while (o + 8 <= b.length) {
      var len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), d = o + 8;
      if (d + len > b.length) { if (lenient) break; throw new Error('PNG chunk ' + type + ' runs past the end of the file'); }
      if (type === 'IHDR') out.ihdr = { W: u32(b, d), H: u32(b, d + 4), depth: b[d + 8], ctype: b[d + 9], comp: b[d + 10], filter: b[d + 11], interlace: b[d + 12] };
      else if (type === 'PLTE') out.plte = b.subarray(d, d + len);
      else if (type === 'tRNS') out.trns = b.subarray(d, d + len);
      else if (type === 'IDAT') { out.idat.push(b.subarray(d, d + len)); out.idatLen += len; }
      else if (type === 'IEND') break;
      o = d + len + 4;
    }
    if (!out.ihdr) throw new Error('PNG without IHDR');
    return out;
  }
  var CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  function sniff(b) {
    if (isPNG(b)) {
      var c = pngChunks(b, true), h = c.ihdr;
      return { type: 'png', W: h.W, H: h.H, depth: h.depth, ctype: h.ctype, interlace: h.interlace,
        alpha: h.ctype === 4 || h.ctype === 6 || !!c.trns, orientation: 1 };
    }
    if (isJPEG(b)) return sniffJPEG(b);
    return { type: 'other', W: null, H: null, alpha: null, orientation: 1 };
  }

  // ------------------------------------------------------------------------------------------------ JPEG header + EXIF
  function exifOrientation(b, o, len) { // o = start of the APP1 payload ("Exif\0\0")
    if (len < 14 || String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) !== 'Exif') return 1;
    var t = o + 6, le = b[t] === 0x49;
    function r16(p) { return le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]); }
    function r32(p) { return le ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + (b[p + 3] << 24 >>> 0)) : u32(b, p); }
    if (r16(t + 2) !== 42) return 1;
    var ifd = t + r32(t + 4);
    if (ifd + 2 > o + len) return 1;
    var n = r16(ifd);
    for (var i = 0; i < n; i++) {
      var e = ifd + 2 + 12 * i;
      if (e + 12 > o + len) break;
      if (r16(e) === 0x0112) { var v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
    return 1;
  }
  function sniffJPEG(b) {
    var o = 2, W = null, H = null, orient = 1;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xFF) { o++; continue; }
      var m = b[o + 1];
      if (m === 0xFF) { o++; continue; }
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { o += 2; continue; }
      if (m === 0xD9 || m === 0xDA) break;
      var len = u16be(b, o + 2);
      if (m === 0xE1 && orient === 1) orient = exifOrientation(b, o + 4, len - 2);
      if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { H = u16be(b, o + 5); W = u16be(b, o + 7); }
      o += 2 + len;
    }
    return { type: 'jpeg', W: W, H: H, alpha: false, orientation: orient };
  }

  // ------------------------------------------------------------------------------------------------ PNG pixels
  function inflate(parts, total) {
    var all = new Uint8Array(total), o = 0;
    for (var i = 0; i < parts.length; i++) { all.set(parts[i], o); o += parts[i].length; }
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('this browser has no DecompressionStream'));
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([all]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  function paeth(a, b, c) { var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
  // unfilter one (sub)image of w x h from raw[o..]; returns {rows: Uint8Array(h * stride), stride, next offset}
  function unfilter(raw, o, w, h, bitsPP) {
    var stride = Math.ceil(w * bitsPP / 8), bpp = Math.max(1, bitsPP >> 3), out = new Uint8Array(h * stride);
    for (var y = 0; y < h; y++) {
      if (o + 1 + stride > raw.length) throw new Error('PNG image data is too short');
      var f = raw[o], src = o + 1, dst = y * stride, up = dst - stride, x;
      for (x = 0; x < stride; x++) {
        var a = x >= bpp ? out[dst + x - bpp] : 0, b = y > 0 ? out[up + x] : 0, c = (y > 0 && x >= bpp) ? out[up + x - bpp] : 0, v = raw[src + x];
        if (f === 0) out[dst + x] = v;
        else if (f === 1) out[dst + x] = (v + a) & 255;
        else if (f === 2) out[dst + x] = (v + b) & 255;
        else if (f === 3) out[dst + x] = (v + ((a + b) >> 1)) & 255;
        else if (f === 4) out[dst + x] = (v + paeth(a, b, c)) & 255;
        else throw new Error('PNG filter type ' + f + ' is not valid');
      }
      o += 1 + stride;
    }
    return { rows: out, stride: stride, next: o };
  }
  // write the pixels of one unfiltered (sub)image into rgb (and alpha count) at positions (x0 + i*dx, y0 + j*dy)
  function emit(c, u, w, h, x0, y0, dx, dy, W, rgb, st) {
    var h0 = c.ihdr, depth = h0.depth, ct = h0.ctype, rows = u.rows, stride = u.stride, pl = c.plte, ch = CHANNELS[ct];
    var gmax = (1 << depth) - 1;
    for (var j = 0; j < h; j++) {
      var row = j * stride, Y = y0 + j * dy;
      for (var i = 0; i < w; i++) {
        var o = 3 * (Y * W + x0 + i * dx), r, g, b, a = 255;
        if (depth < 8) { // grey (0) or palette (3), 1/2/4 bits, MSB first
          var bit = i * depth, v = (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & gmax;
          if (ct === 3) { r = g = b = 0; if (pl && 3 * v + 2 < pl.length) { r = pl[3 * v]; g = pl[3 * v + 1]; b = pl[3 * v + 2]; } if (c.trns && v < c.trns.length) a = c.trns[v]; }
          else { r = g = b = Math.round(v * 255 / gmax); if (c.trns && c.trns.length >= 2 && v === u16be(c.trns, 0)) a = 0; }
        } else if (depth === 8) {
          var p = row + i * ch;
          if (ct === 0) { r = g = b = rows[p]; if (c.trns && c.trns.length >= 2 && rows[p] === u16be(c.trns, 0)) a = 0; }
          else if (ct === 2) { r = rows[p]; g = rows[p + 1]; b = rows[p + 2]; if (c.trns && c.trns.length >= 6 && r === u16be(c.trns, 0) && g === u16be(c.trns, 2) && b === u16be(c.trns, 4)) a = 0; }
          else if (ct === 3) { var k = rows[p]; r = g = b = 0; if (pl && 3 * k + 2 < pl.length) { r = pl[3 * k]; g = pl[3 * k + 1]; b = pl[3 * k + 2]; } if (c.trns && k < c.trns.length) a = c.trns[k]; }
          else if (ct === 4) { r = g = b = rows[p]; a = rows[p + 1]; }
          else { r = rows[p]; g = rows[p + 1]; b = rows[p + 2]; a = rows[p + 3]; }
        } else { // 16 bit: PIL keeps the HIGH byte for colour; 16-bit grey opens as mode "I" and convert("RGB") CLIPS at 255
          var q = row + i * ch * 2;
          if (ct === 0) { var gv = (rows[q] << 8) | rows[q + 1]; r = g = b = gv > 255 ? 255 : gv; }
          else if (ct === 2) { r = rows[q]; g = rows[q + 2]; b = rows[q + 4]; }
          else if (ct === 4) { r = g = b = rows[q]; a = rows[q + 2]; }
          else { r = rows[q]; g = rows[q + 2]; b = rows[q + 4]; a = rows[q + 6]; }
        }
        rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
        if (a < 255) { st.translucent++; if (a === 0) st.transparent++; }
      }
    }
  }
  var ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  function decodePNG(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isPNG(b)) return Promise.reject(new Error('not a PNG'));
    var c;
    try { c = pngChunks(b); } catch (e) { return Promise.reject(e); }
    var h = c.ihdr, ok = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[h.ctype];
    if (!ok || ok.indexOf(h.depth) < 0) return Promise.reject(new Error('PNG colour type ' + h.ctype + ' at ' + h.depth + ' bits is not valid'));
    if (h.comp !== 0 || h.filter !== 0 || h.interlace > 1) return Promise.reject(new Error('PNG uses an unknown compression, filter or interlace method'));
    if (h.W < 1 || h.H < 1 || h.W * h.H > 64e6) return Promise.reject(new Error('PNG is ' + h.W + ' x ' + h.H + ': out of range'));
    if (h.ctype === 3 && !c.plte) return Promise.reject(new Error('palette PNG without a palette'));
    return inflate(c.idat, c.idatLen).then(function (raw) {
      var W = h.W, H = h.H, rgb = new Uint8Array(W * H * 3), st = { translucent: 0, transparent: 0 }, bitsPP = CHANNELS[h.ctype] * h.depth;
      if (!h.interlace) {
        emit(c, unfilter(raw, 0, W, H, bitsPP), W, H, 0, 0, 1, 1, W, rgb, st);
      } else {
        var o = 0;
        for (var p = 0; p < 7; p++) {
          var A = ADAM7[p], pw = Math.ceil((W - A[0]) / A[2]), ph = Math.ceil((H - A[1]) / A[3]);
          if (pw <= 0 || ph <= 0) continue;
          var u = unfilter(raw, o, pw, ph, bitsPP);
          emit(c, u, pw, ph, A[0], A[1], A[2], A[3], W, rgb, st);
          o = u.next;
        }
      }
      return { rgb: rgb, W: W, H: H, translucent: st.translucent, transparent: st.transparent, depth: h.depth, ctype: h.ctype, interlace: h.interlace };
    });
  }

  // ------------------------------------------------------------------------------------------------ orientation
  // rgb was decoded by an engine that APPLIED EXIF orientation o (so it is the displayed picture, dW x dH); return the
  // stored picture. Stored pixel (sx, sy) sits at displayed (dx, dy):
  //   2 (W-1-sx, sy)  3 (W-1-sx, H-1-sy)  4 (sx, H-1-sy)  5 (sy, sx)  6 (H-1-sy, sx)  7 (H-1-sy, W-1-sx)  8 (sy, W-1-sx)
  function undoOrientation(rgb, dW, dH, o) {
    if (!(o >= 2 && o <= 8)) return { rgb: rgb, W: dW, H: dH };
    var swap = o >= 5, W = swap ? dH : dW, H = swap ? dW : dH, out = new Uint8Array(W * H * 3);
    for (var sy = 0; sy < H; sy++) for (var sx = 0; sx < W; sx++) {
      var dx, dy;
      switch (o) {
        case 2: dx = W - 1 - sx; dy = sy; break;
        case 3: dx = W - 1 - sx; dy = H - 1 - sy; break;
        case 4: dx = sx; dy = H - 1 - sy; break;
        case 5: dx = sy; dy = sx; break;
        case 6: dx = H - 1 - sy; dy = sx; break;
        case 7: dx = H - 1 - sy; dy = W - 1 - sx; break;
        default: dx = sy; dy = W - 1 - sx;
      }
      var s = 3 * (dy * dW + dx), t = 3 * (sy * W + sx);
      out[t] = rgb[s]; out[t + 1] = rgb[s + 1]; out[t + 2] = rgb[s + 2];
    }
    return { rgb: out, W: W, H: H };
  }
  // 16 x 8 stored, EXIF orientation 6 (made with PIL; left half green, right half red)
  var PROBE_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwArCooryKXUrhX/AJe/9u/qf//Z';
  function probeBytes() { var s = atob(PROBE_JPEG), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

  var api = { sniff: sniff, decodePNG: decodePNG, undoOrientation: undoOrientation, PROBE_JPEG: PROBE_JPEG, probeBytes: probeBytes, VERSION: 'decode.js 1.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HPDecode = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));

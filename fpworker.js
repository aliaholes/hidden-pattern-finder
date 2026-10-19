/* fpworker.js -- streams images for the Fingerprint tab: decode (createImageBitmap, no colour conversion), take the
 * fixed centre crop, add its residual power spectrum to this worker's running sum. Only the sum goes back. Offline.
 * PIXEL CAP (port, Oct 17 2026): a picture is decoded whole just to keep a 512 x 512 crop, so pictures over MAX_PX
 * (40 megapixels, about 160 MB decoded) are skipped. PNG / JPEG / WebP sizes are read from the file header BEFORE
 * decoding; other formats (GIF, BMP, AVIF) can only be checked after the decode. Stored orientation, like the rest of
 * the page (EXIF rotation is not applied where the browser allows that). */
importScripts('meter.js', 'spectrum.js', 'decode.js'); // spectrum.js = the PR's fingerprint.js (blockers stop that name)
var F = self.HPFinger, S = F.S, sum = null, n = 0, MAX_PX = 40000000;
var NO_CM = { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' };
function webpSize(b) { // RIFF....WEBP then VP8X / VP8 / VP8L: the canvas size, or null
  if (b.length < 30 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RIFF' || String.fromCharCode(b[8], b[9], b[10], b[11]) !== 'WEBP') return null;
  var t = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (t === 'VP8X') return { W: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), H: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (t === 'VP8 ') return { W: (b[26] | (b[27] << 8)) & 0x3fff, H: (b[28] | (b[29] << 8)) & 0x3fff };
  if (t === 'VP8L' && b[20] === 0x2f) { var v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; return { W: 1 + (v & 0x3fff), H: 1 + ((v >>> 14) & 0x3fff) }; }
  return null;
}
function headerSize(file) {
  return file.slice(0, 262144).arrayBuffer().then(function (ab) {
    var b = new Uint8Array(ab), w = webpSize(b);
    if (w) return w;
    var info = null;
    try { info = self.HPDecode ? self.HPDecode.sniff(b) : null; } catch (e) { info = null; } // a broken header: the decode decides
    return info && info.W && info.H ? { W: info.W, H: info.H } : null;
  }, function () { return null; });
}
self.onmessage = async function (ev) {
  var m = ev.data;
  if (m.cmd === 'reset') { sum = new Float64Array(S * S); n = 0; self.postMessage({ cmd: 'reset', id: m.id }); return; }
  if (m.cmd === 'add') {
    var res = { cmd: 'added', id: m.id, ok: false };
    try {
      var hs = await headerSize(m.file);
      if (hs && hs.W * hs.H > MAX_PX) { res.W = hs.W; res.H = hs.H; res.reason = 'over ' + (MAX_PX / 1e6) + ' megapixels (' + hs.W + ' x ' + hs.H + '), skipped to keep memory in bounds'; self.postMessage(res); return; }
      var bmp;
      try { bmp = await createImageBitmap(m.file, NO_CM); } catch (e1) { bmp = await createImageBitmap(m.file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
      res.W = bmp.width; res.H = bmp.height;
      if (bmp.width < S || bmp.height < S) { res.reason = 'smaller than ' + S + ' px'; bmp.close(); }
      else if (bmp.width * bmp.height > MAX_PX) { res.reason = 'over ' + (MAX_PX / 1e6) + ' megapixels (' + bmp.width + ' x ' + bmp.height + ')'; bmp.close(); }
      else {
        var o = F.cropOffset(bmp.height, bmp.width), cv = new OffscreenCanvas(S, S), cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp, o.x, o.y, S, S, 0, 0, S, S); bmp.close();
        var d = cx.getImageData(0, 0, S, S).data, g = new Float64Array(S * S);
        for (var i = 0; i < S * S; i++) g[i] = d[i * 4 + 1]; // green channel
        F.accumulate(g, sum); n++; res.ok = true;
      }
    } catch (e) { res.reason = 'could not decode (' + (e && e.message || e) + ')'; }
    self.postMessage(res); return;
  }
  if (m.cmd === 'sum') { var s = sum; sum = new Float64Array(S * S); self.postMessage({ cmd: 'sum', id: m.id, n: n, sum: s.buffer }, [s.buffer]); n = 0; }
};

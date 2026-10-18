/* fpworker.js -- streams images for the Fingerprint tab: decode (createImageBitmap, no colour conversion), take the
 * fixed centre crop, add its residual power spectrum to this worker's running sum. Only the sum goes back. Offline. */
importScripts('meter.js', 'fingerprint.js');
var F = self.HPFinger, S = F.S, sum = null, n = 0;
self.onmessage = async function (ev) {
  var m = ev.data;
  if (m.cmd === 'reset') { sum = new Float64Array(S * S); n = 0; self.postMessage({ cmd: 'reset', id: m.id }); return; }
  if (m.cmd === 'add') {
    var res = { cmd: 'added', id: m.id, ok: false };
    try {
      var bmp = await createImageBitmap(m.file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      res.W = bmp.width; res.H = bmp.height;
      if (bmp.width < S || bmp.height < S) { res.reason = 'smaller than ' + S + ' px'; bmp.close(); }
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

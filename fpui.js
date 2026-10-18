/* fpui.js -- the Fingerprint tab. Streams files to a small pool of fpworker.js workers (one file in flight per worker,
 * so memory stays flat for hundreds of images), merges their power sums, then draws the views. Display only. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, F = window.HPFinger, S = F.S;
  var sets = { A: [], B: [] }, busy = false;
  var IMG = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
  function status(msg, err) { var s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); }
  function progress(f) { var b = $('bar'); b.hidden = f == null; if (f != null) b.firstChild.style.width = Math.round(f * 100) + '%'; }
  function setFiles(which, list) {
    sets[which] = Array.prototype.filter.call(list, function (f) { return (f.type && f.type.indexOf('image/') === 0) || IMG.test(f.name); });
    $('fpInfo' + which).textContent = sets[which].length ? sets[which].length + ' image' + (sets[which].length === 1 ? '' : 's') + (which === 'B' ? ' in the control' : ' in the set') : '';
    $('fpClearB').hidden = !sets.B.length; $('fpRun').disabled = !sets.A.length || busy;
  }
  ['A', 'B'].forEach(function (w) {
    $('fpFile' + w).onchange = function (e) { setFiles(w, e.target.files); };
    $('fpDir' + w).onchange = function (e) { setFiles(w, e.target.files); };
    var drop = $('fpDrop' + w);
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var items = e.dataTransfer.items, entries = [];
      if (items) for (var i = 0; i < items.length; i++) { var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); if (en) entries.push(en); }
      if (!entries.length) { setFiles(w, e.dataTransfer.files); return; }
      walk(entries).then(function (files) { setFiles(w, files); });
    });
  });
  $('fpClearB').onclick = function () { $('fpFileB').value = ''; $('fpDirB').value = ''; setFiles('B', []); };
  function walk(entries) { // folders dropped onto the box: read them recursively
    var out = [];
    function one(en) {
      if (en.isFile) return new Promise(function (r) { en.file(function (f) { out.push(f); r(); }, function () { r(); }); });
      if (!en.isDirectory) return Promise.resolve();
      var rd = en.createReader();
      return new Promise(function (r) {
        var all = [];
        (function more() { rd.readEntries(function (b) { if (!b.length) Promise.all(all.map(one)).then(r); else { all = all.concat(b); more(); } }, function () { r(); }); })();
      });
    }
    return Promise.all(entries.map(one)).then(function () { return out; });
  }

  // ---------------------------------------------------------------- run
  function runSet(files, label, base, span) {
    var NW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)), ws = [], next = 0, done = 0, skipped = [], seq = 0;
    for (var i = 0; i < NW; i++) ws.push(new Worker('fpworker.js'));
    function call(w, msg) { return new Promise(function (res) { msg.id = ++seq; w.onmessage = function (ev) { res(ev.data); }; w.postMessage(msg, msg.sum ? [msg.sum] : []); }); }
    function loop(w) {
      if (next >= files.length) return Promise.resolve();
      var f = files[next++];
      return call(w, { cmd: 'add', file: f }).then(function (r) {
        done++; if (!r.ok) skipped.push(f.name + ': ' + r.reason);
        progress(base + span * done / files.length); status(label + ': ' + done + ' / ' + files.length);
        return loop(w);
      });
    }
    return Promise.all(ws.map(function (w) { return call(w, { cmd: 'reset' }); }))
      .then(function () { return Promise.all(ws.map(loop)); })
      .then(function () { return Promise.all(ws.map(function (w) { return call(w, { cmd: 'sum' }); })); })
      .then(function (rs) {
        ws.forEach(function (w) { w.terminate(); });
        var sum = new Float64Array(S * S), n = 0;
        rs.forEach(function (r) { var s = new Float64Array(r.sum); for (var k = 0; k < s.length; k++) sum[k] += s[k]; n += r.n; });
        if (!n) return { n: 0, skipped: skipped };
        var out = F.finalize(sum, n); out.skipped = skipped; return out;
      });
  }
  $('fpRun').onclick = function () {
    if (busy || !sets.A.length) return;
    busy = true; $('fpRun').disabled = true; $('fpOut').hidden = true; delete $('fpOut').dataset.ready;
    var hasB = sets.B.length > 0, t0 = performance.now(), A, B;
    runSet(sets.A, 'Set', 0, hasB ? 0.5 : 1).then(function (a) {
      A = a; return hasB ? runSet(sets.B, 'Control', 0.5, 0.5) : null;
    }).then(function (b) {
      B = b; progress(null);
      if (!A.n) { status('No usable pictures in the set (all smaller than ' + S + ' px or unreadable).', true); return; }
      var cmp = B && B.n ? F.compare(A, B) : null;
      window.__fp = { A: A, B: B && B.n ? B : null, cmp: cmp };
      draw(A, B && B.n ? B : null, cmp);
      status('Done. ' + A.n + ' pictures in the set' + (B ? ', ' + B.n + ' in the control' : '') + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s.');
    }).catch(function (e) { progress(null); status('Fingerprint failed: ' + (e && e.message || e), true); })
      .then(function () { busy = false; $('fpRun').disabled = !sets.A.length; });
  };

  // ---------------------------------------------------------------- drawing
  var INF = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  var DIV = [[33, 102, 172], [103, 169, 207], [209, 229, 240], [247, 247, 247], [253, 219, 199], [239, 138, 98], [178, 24, 43]];
  function cmap(t, M) { if (!isFinite(t)) t = 0; t = Math.max(0, Math.min(1, t)) * (M.length - 1); var i = Math.min(M.length - 2, Math.floor(t)), f = t - i, a = M[i], b = M[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
  function pct(a, p) { var s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
  function view(title, sub, arr, n, lo, hi, M, unit, peaks) {
    if (!(hi > lo)) hi = lo + 1;
    var fig = document.createElement('figure'), cv = document.createElement('canvas'), BAR = 34;
    cv.width = n; cv.height = n + BAR; cv.style.width = '100%'; cv.style.background = '#000';
    var cx = cv.getContext('2d'), im = cx.createImageData(n, n);
    for (var i = 0; i < n * n; i++) { var c = cmap((arr[i] - lo) / (hi - lo), M); im.data[i * 4] = c[0]; im.data[i * 4 + 1] = c[1]; im.data[i * 4 + 2] = c[2]; im.data[i * 4 + 3] = 255; }
    cx.putImageData(im, 0, 0);
    if (peaks) peaks.forEach(function (p, k) {
      cx.strokeStyle = p.label ? '#5aa9ff' : '#ff3b30'; cx.lineWidth = 2;
      [[1, 1], [-1, -1]].forEach(function (sg) { cx.beginPath(); cx.arc(n / 2 + sg[0] * p.fx, n / 2 - sg[1] * p.fy, 9, 0, 2 * Math.PI); cx.stroke(); });
      cx.fillStyle = '#fff'; cx.font = '12px monospace'; cx.fillText(String(k + 1), n / 2 + p.fx + 11, n / 2 - p.fy - 8);
    });
    for (var x = 0; x < n; x++) { var c2 = cmap(x / (n - 1), M); cx.fillStyle = 'rgb(' + c2.map(Math.round).join(',') + ')'; cx.fillRect(x, n + 4, 1, 12); }
    cx.fillStyle = '#ccc'; cx.font = '12px monospace'; cx.textBaseline = 'top';
    cx.fillText(lo.toFixed(2), 2, n + 18); var ht = hi.toFixed(2) + ' ' + unit; cx.fillText(ht, n - cx.measureText(ht).width - 2, n + 18);
    var cap = document.createElement('figcaption'); cap.className = 'legend'; cap.innerHTML = '<b style="border:0;width:auto;height:auto;margin:0">' + title + '</b>&nbsp;' + sub;
    fig.appendChild(cv); fig.appendChild(cap); return fig;
  }
  function crop(arr, m) { var o = new Float32Array(m * m), off = S / 2 - (m - 1) / 2; for (var y = 0; y < m; y++) for (var x = 0; x < m; x++) o[y * m + x] = arr[(y + off) * S + x + off]; return o; }
  function plot(cv, series, xlab, xs) {
    var cx = cv.getContext('2d'), W = cv.width, H = cv.height, L = 48, B = 34, T = 10, R = 10;
    cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) { s.y.forEach(function (v, i) { if (i >= (s.from || 0) && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    if (!isFinite(lo)) return; var pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    cx.strokeStyle = '#555'; cx.strokeRect(L, T, W - L - R, H - T - B);
    cx.fillStyle = '#aaa'; cx.font = '11px monospace';
    cx.fillText(hi.toFixed(1), 2, T + 10); cx.fillText(lo.toFixed(1), 2, H - B); cx.fillText(xlab, L, H - 6);
    xs.forEach(function (t) { var px = L + (W - L - R) * t.at; cx.fillText(t.txt, px - 8, H - B + 14); });
    series.forEach(function (s, k) {
      cx.strokeStyle = s.color; cx.lineWidth = 1.5; cx.beginPath(); var n = s.y.length, first = true;
      for (var i = s.from || 0; i < n; i++) { var v = s.y[i]; if (!isFinite(v)) continue; var px = L + (W - L - R) * i / (n - 1), py = T + (H - T - B) * (1 - (v - lo) / (hi - lo)); if (first) { cx.moveTo(px, py); first = false; } else cx.lineTo(px, py); }
      cx.stroke(); cx.fillStyle = s.color; cx.fillText(s.name, W - R - 150, T + 14 + 14 * k);
    });
  }
  function peakRows(title, ps) {
    if (!ps.length) return '<tr><th colspan="6">' + title + ': no peaks above 6 x the typical deviation</th></tr>';
    return '<tr><th colspan="6">' + title + '</th></tr><tr><th>#</th><th>Period (px)</th><th>Frequency direction</th><th>Stripe angle</th><th>Strength (x typical)</th><th>Note</th></tr>' +
      ps.map(function (p, i) { var st = ((p.angle + 90) % 180); return '<tr><td>' + (i + 1) + '</td><td>' + p.period.toFixed(1) + '</td><td>' + p.angle.toFixed(0) + '&deg;</td><td>' + st.toFixed(0) + '&deg;</td><td>' + p.z.toFixed(1) + '</td><td>' + (p.label || '') + '</td></tr>'; }).join('');
  }
  function draw(A, B, cmp) {
    var v = $('fpViews'); v.innerHTML = '';
    var sub = function (X) { return 'log power, N = ' + X.n + ' (' + S + ' px crops). Rings: peaks (red), 8-px JPEG grid (blue). The axis cross is never ranked.'; };
    v.appendChild(view('Set', sub(A), A.logP, S, pct(A.logP, 0.01), pct(A.logP, 0.998), INF, 'ln', A.peaks));
    if (B) v.appendChild(view('Control', sub(B), B.logP, S, pct(B.logP, 0.01), pct(B.logP, 0.998), INF, 'ln', B.peaks));
    if (cmp) { var m = Math.max(Math.abs(pct(cmp.diff, 0.005) - cmp.mean), Math.abs(pct(cmp.diff, 0.995) - cmp.mean));
      v.appendChild(view('Set / control', 'log power ratio (red = more in the set, blue = more in the control), centred on the mean ratio ' + cmp.mean.toFixed(2) + '.', cmp.diff, S, cmp.mean - m, cmp.mean + m, DIV, 'ln ratio', cmp.peaks)); }
    var M2 = 129, ac = crop(A.ac, M2), acv = ac.slice(); acv[(M2 * M2) >> 1] = 0;
    var am = Math.max(Math.abs(pct(acv, 0.002)), Math.abs(pct(acv, 0.998)));
    v.appendChild(view('Set autocorrelation', 'of the residual, lags -64..64 px (centre removed). A repeat shows as a lattice of spots.', ac, M2, -am, am, DIV, '', null));
    var R = S / 2, tick = [8, 4, 2].map(function (p) { return { at: (S / p) / R, txt: p + 'px' }; });
    plot($('fpRadial'), [{ name: 'set', y: A.radial, color: '#ff6b5b', from: 2 }].concat(B ? [{ name: 'control', y: B.radial, color: '#7fb8ff', from: 2 }] : []), 'distance from centre (period labelled)', tick);
    plot($('fpAzim'), [{ name: 'set', y: A.azim, color: '#ff6b5b' }].concat(B ? [{ name: 'control', y: B.azim, color: '#7fb8ff' }] : []), 'frequency direction 0..180 deg',
      [0, 45, 90, 135].map(function (d) { return { at: d / 179, txt: d + '' }; }));
    $('fpPeaks').innerHTML = peakRows('Set peaks', A.peaks) + (B ? peakRows('Control peaks', B.peaks) : '') + (cmp ? peakRows('Set-vs-control peaks (ratio)', cmp.peaks) : '');
    var sk = A.skipped.concat(B ? B.skipped : []);
    $('fpSummary').textContent = 'Set: ' + A.n + ' pictures' + (B ? '; control: ' + B.n : '') + (sk.length ? '; skipped ' + sk.length + ' (' + sk.slice(0, 3).join('; ') + (sk.length > 3 ? '; ...' : '') + ')' : '') + '. Peaks are local maxima of the spectrum after removing its average fall-off with frequency.';
    $('fpOut').dataset.ready = '1'; $('fpOut').hidden = false;
  }
})();

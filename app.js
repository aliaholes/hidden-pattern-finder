/* app.js -- the Hidden Pattern Finder page. Decodes the file IN the browser (createImageBitmap + canvas), hands the pixels
 * to worker.js (meter.js inside), draws what comes back. No network: no fetch, no XHR, no beacons, no analytics. The page's
 * Content-Security-Policy (connect-src 'none') blocks them even if something tried. */
'use strict';
(function () {
  var M = window.HPMeter, T = M.T_FROZEN, TL = M.T_LATTICE_FROZEN;
  var $ = function (id) { return document.getElementById(id); };
  var NW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  var pool = [], jobs = [], pending = {}, seq = 0, runId = 0;
  var state = { perms: {}, order: [], view: 'pic', extras: {}, img: null, verdict: null };

  $('cores').textContent = NW + (NW === 1 ? ' worker' : ' workers') + ' on this device';

  // ------------------------------------------------------------------ tabs
  function tab(which) {
    $('tab-one').setAttribute('aria-selected', which === 'one');
    $('tab-many').setAttribute('aria-selected', which === 'many');
    $('one').hidden = which !== 'one'; $('many').hidden = which !== 'many';
  }
  $('tab-one').onclick = function () { tab('one'); };
  $('tab-many').onclick = function () { tab('many'); };

  function status(msg, isErr) { var s = $('status'); s.textContent = msg; s.className = 'status' + (isErr ? ' err' : ''); }
  function progress(f) { var b = $('bar'); b.hidden = f == null; if (f != null) b.firstChild.style.width = Math.round(f * 100) + '%'; }

  // ------------------------------------------------------------------ decode (all local; decode.js, wave 4)
  // The command-line scanner reads PIL's Image.open(p).convert("RGB"): colour under transparency KEPT, EXIF orientation
  // IGNORED (pixels as stored), no colour management. PNGs go through decode.js's own reader (byte-exact with PIL);
  // everything else through the browser, asking for the same and checking what we got.
  var D = window.HPDecode, probe = null;
  function bitmapToRGB(bmp) {
    var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    var W = bmp.width, H = bmp.height, d = ctx.getImageData(0, 0, W, H).data, n = W * H, rgb = new Uint8Array(n * 3), seeThrough = 0;
    for (var i = 0; i < n; i++) { rgb[3 * i] = d[4 * i]; rgb[3 * i + 1] = d[4 * i + 1]; rgb[3 * i + 2] = d[4 * i + 2]; if (d[4 * i + 3] < 255) seeThrough++; }
    if (bmp.close) bmp.close();
    return { rgb: rgb, W: W, H: H, seeThrough: seeThrough };
  }
  var NO_CM = { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' };
  function browserDecode(blob) { // -> {rgb, W, H, seeThrough, fallback}
    return createImageBitmap(blob, NO_CM).then(function (b) { var r = bitmapToRGB(b); r.fallback = false; return r; },
      function () { return createImageBitmap(blob).then(function (b) { var r = bitmapToRGB(b); r.fallback = true; return r; }); });
  }
  // does THIS engine apply EXIF orientation even when asked not to? (decode a 16 x 8 JPEG tagged 6: 8 x 16 = it rotated)
  function orientationProbe() {
    if (!probe) probe = browserDecode(new Blob([D.probeBytes()], { type: 'image/jpeg' })).then(function (r) {
      return { applies: r.W === 8 && r.H === 16, fallback: r.fallback };
    }, function () { return { applies: null, fallback: true }; });
    return probe;
  }
  function decode(file) {
    return file.arrayBuffer().then(function (ab) {
      var bytes = new Uint8Array(ab), info = D.sniff(bytes), notes = [];
      var base = { name: file.name, bytes: file.size, notes: notes, kind: info.type };
      if (info.type === 'png') {
        return D.decodePNG(bytes).then(function (r) {
          if (r.translucent) notes.push('This PNG has transparency (' + r.translucent.toLocaleString() + ' px). Like the command-line scanner, the finder reads the colour stored under it; it does not paint it onto a background.');
          return Object.assign(base, { rgb: r.rgb, W: r.W, H: r.H, path: 'png-exact' });
        }, function (e) { // our reader refused: let the browser try, and say so
          notes.push('Read by the browser (' + e.message + '), so colour under transparent pixels may be lost.');
          return browserDecode(new Blob([bytes])).then(function (r) { return Object.assign(base, { rgb: r.rgb, W: r.W, H: r.H, path: 'browser' }); });
        });
      }
      return browserDecode(new Blob([bytes], { type: file.type || '' })).then(function (r) {
        if (r.seeThrough) notes.push('This picture has transparency (' + r.seeThrough.toLocaleString() + ' px). For this format the browser cannot show the colour under it; save it as PNG to read it exactly.');
        if (r.fallback) notes.push('This browser would not decode without colour management; colours may be shifted slightly from the file\'s own values.');
        var o = info.type === 'jpeg' ? info.orientation : 1;
        if (o === 1) return Object.assign(base, { rgb: r.rgb, W: r.W, H: r.H, path: 'browser' });
        return orientationProbe().then(function (pr) {
          var swapped = info.W && info.H && r.W === info.H && r.H === info.W && info.W !== info.H;
          var applied = swapped || r.fallback || pr.applies === true;
          var fixed = applied ? D.undoOrientation(r.rgb, r.W, r.H, o) : { rgb: r.rgb, W: r.W, H: r.H };
          if (info.W && (fixed.W !== info.W || fixed.H !== info.H)) throw new Error('Could not read ' + file.name + ' in its stored orientation (got ' + fixed.W + ' x ' + fixed.H + ', the file says ' + info.W + ' x ' + info.H + ').');
          notes.push('The file is tagged to be shown rotated or flipped (EXIF orientation ' + o + '). Like the command-line scanner, the finder reads it as stored, so it may look turned here, and every angle is measured in the file\'s own orientation.');
          return Object.assign(base, { rgb: fixed.rgb, W: fixed.W, H: fixed.H, path: applied ? 'browser+unrotated' : 'browser' });
        });
      });
    });
  }
  // the stored size without decoding when the header says it (PNG, JPEG); otherwise decode
  function sizeOf(file) {
    return file.slice(0, 262144).arrayBuffer().then(function (ab) {
      var info = D.sniff(new Uint8Array(ab));
      if (info.W && info.H) return { W: info.W, H: info.H };
      return decode(file).then(function (r) { return { W: r.W, H: r.H }; });
    });
  }
  function boxDownRGB(img, cap) { // area average to fit cap (deviation D6)
    var W = img.W, H = img.H, s = cap / Math.max(W, H);
    if (s >= 1) return img;
    var tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s)), out = new Uint8Array(tw * th * 3);
    for (var ty = 0; ty < th; ty++) {
      var y0 = ty * H / th, y1 = (ty + 1) * H / th;
      for (var tx = 0; tx < tw; tx++) {
        var x0 = tx * W / tw, x1 = (tx + 1) * W / tw, acc = [0, 0, 0], wsum = 0;
        for (var y = Math.floor(y0); y < Math.ceil(y1); y++) {
          var wy = Math.min(y + 1, y1) - Math.max(y, y0);
          for (var x = Math.floor(x0); x < Math.ceil(x1); x++) {
            var wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0)), i = 3 * (y * W + x);
            acc[0] += img.rgb[i] * wgt; acc[1] += img.rgb[i + 1] * wgt; acc[2] += img.rgb[i + 2] * wgt; wsum += wgt;
          }
        }
        var o = 3 * (ty * tw + tx);
        out[o] = Math.round(acc[0] / wsum); out[o + 1] = Math.round(acc[1] / wsum); out[o + 2] = Math.round(acc[2] / wsum);
      }
    }
    return { rgb: out, W: tw, H: th, name: img.name, bytes: img.bytes, from: [W, H], notes: img.notes, path: img.path };
  }
  function drawRGB(canvas, img, max) {
    var s = Math.min(1, max / Math.max(img.W, img.H)), w = Math.max(1, Math.round(img.W * s)), h = Math.max(1, Math.round(img.H * s));
    var c = document.createElement('canvas'); c.width = img.W; c.height = img.H;
    var id = c.getContext('2d').createImageData(img.W, img.H), n = img.W * img.H;
    for (var i = 0; i < n; i++) { id.data[4 * i] = img.rgb[3 * i]; id.data[4 * i + 1] = img.rgb[3 * i + 1]; id.data[4 * i + 2] = img.rgb[3 * i + 2]; id.data[4 * i + 3] = 255; }
    c.getContext('2d').putImageData(id, 0, 0);
    canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(c, 0, 0, w, h);
  }
  function putPack(canvas, pk) {
    canvas.width = pk.w; canvas.height = pk.h;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pk.buf), pk.w, pk.h), 0, 0);
  }

  // ------------------------------------------------------------------ the worker pool
  function killPool() { pool.forEach(function (w) { w.w.terminate(); }); pool = []; jobs = []; pending = {}; }
  function makePool(n) {
    killPool();
    for (var i = 0; i < n; i++) {
      var w = new Worker('worker.js'), slot = { w: w, busy: false };
      w.onmessage = (function (s) { return function (ev) { onMsg(s, ev.data); }; })(slot);
      w.onerror = function (e) { status('A worker failed: ' + (e.message || 'unknown error'), true); };
      pool.push(slot);
    }
  }
  function send(slot, msg, transfer) {
    msg.id = ++seq; slot.busy = true;
    return new Promise(function (res, rej) { pending[msg.id] = { res: res, rej: rej }; slot.w.postMessage(msg, transfer || []); });
  }
  function onMsg(slot, m) {
    slot.busy = false;
    var p = pending[m.id]; delete pending[m.id];
    if (!p) return;
    if (m.cmd === 'error') p.rej(new Error(m.error)); else p.res(m);
    pump();
  }
  function pump() {
    pool.forEach(function (s) {
      if (s.busy || !jobs.length) return;
      var j = jobs.shift();
      send(s, j.msg).then(j.res, j.rej);
    });
  }
  function queue(msg) { return new Promise(function (res, rej) { jobs.push({ msg: msg, res: res, rej: rej }); pump(); }); }
  function idle() { for (var i = 0; i < pool.length; i++) if (!pool[i].busy) return pool[i]; return pool[0]; }

  // ------------------------------------------------------------------ ONE IMAGE
  function runOne(file) {
    var my = ++runId, cap = +$('cap').value;
    $('verdict').hidden = true; $('results').hidden = true; $('multi').hidden = true; $('extrasWrap').hidden = true;
    $('grid').innerHTML = ''; $('extras').innerHTML = '';
    state = { perms: {}, view: state.view, extras: {}, img: null, verdict: null, decodePath: null };
    delete $('verdict').dataset.json;
    status('Reading ' + file.name + ' on this device...'); progress(0);
    decode(file).then(function (raw) {
      if (my !== runId) return;
      var img = boxDownRGB(raw, cap);
      if (Math.min(img.W, img.H) < 192) throw new Error('This picture is ' + img.W + ' x ' + img.H + ' px. It needs at least 192 px on its short side (four quarters of 96 px each).');
      state.img = img;
      $('src').hidden = false; drawRGB($('srcCanvas'), img, 160);
      $('srcInfo').textContent = raw.name + ' - ' + raw.W + ' x ' + raw.H + ' px' + (img.from ? ' (analysed at ' + img.W + ' x ' + img.H + ': area-averaged down to the ' + cap + ' px setting, so periods are in the smaller pixels)' : ' (analysed at full size)') + (raw.notes.length ? ' ' + raw.notes.join(' ') : '');
      state.decodePath = raw.path;
      makePool(NW);
      return Promise.all(pool.map(function (s) { return send(s, { cmd: 'init', rgb: img.rgb.buffer.slice(0), H: img.H, W: img.W }); }));
    }).then(function () {
      if (my !== runId || !state.img) return;
      $('results').hidden = false;
      var done = 0, t0 = performance.now(), total = M.PERMS.length;
      status('Looking: 0 / ' + total + ' views');
      return Promise.all(M.PERMS.map(function (pr) {
        return queue({ cmd: 'perm', name: pr[1], thumb: 240 }).then(function (r) {
          if (my !== runId) return;
          state.perms[r.name] = r; done++;
          addCell(r); progress(done / total);
          var el = (performance.now() - t0) / 1000;
          status('Looking: ' + done + ' / ' + total + ' views (' + el.toFixed(0) + ' s' + (done < total ? ', about ' + Math.max(1, Math.round(el / done * (total - done))) + ' s left' : '') + ')');
        });
      })).then(function () {
        if (my !== runId) return;
        finishOne((performance.now() - t0) / 1000);
      });
    }).catch(function (e) { if (my === runId) { status(e.message || String(e), true); progress(null); } });
  }

  function addCell(r) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'cell'; b.dataset.name = r.name;
    var sc = r.score.score;
    if (sc >= 1) b.classList.add('hot');
    var pic = document.createElement('span'); pic.className = 'pic';
    var cv = document.createElement('canvas'); putPack(cv, r.thumb); pic.appendChild(cv);
    var sp = document.createElement('canvas'); if (r.spec) putPack(sp, r.spec); sp.hidden = true; pic.appendChild(sp);
    b._pic = cv; b._spec = sp;
    var lab = document.createElement('span'); lab.className = 'lab';
    lab.innerHTML = '<span class="no"></span><span class="t"></span><span class="s"></span><span class="meter"><i></i></span>';
    lab.querySelector('.t').textContent = r.name;
    var where = r.score.cand >= r.score.lattice / TL * T ? r.score.cand_where : r.score.lattice_where;
    lab.querySelector('.s').textContent = r.family + ' - score ' + sc.toFixed(2) + (where ? ' - best ' + where[1].toFixed(1) + ' px @ ' + where[2].toFixed(0) + '\u00b0 (' + where[0] + ')' : '');
    lab.querySelector('.meter i').style.width = Math.min(100, sc / 2 * 100) + '%';
    b.appendChild(pic); b.appendChild(lab);
    b.onclick = function () { openDetail(r.name); };
    b._score = sc;
    setView(b);
    var grid = $('grid'), kids = grid.children, at = null;
    for (var i = 0; i < kids.length; i++) if (kids[i]._score < sc) { at = kids[i]; break; }
    grid.insertBefore(b, at);
    renumber();
  }
  function renumber() { var kids = $('grid').children; for (var i = 0; i < kids.length; i++) kids[i].querySelector('.no').textContent = (i + 1 < 10 ? '0' : '') + (i + 1); }
  function setView(cell) { var spec = state.view === 'spec' && cell._spec && cell._spec.width > 0; cell._pic.hidden = spec; cell._spec.hidden = !spec; }
  Array.prototype.forEach.call(document.querySelectorAll('.toggle button'), function (bt) {
    bt.onclick = function () {
      state.view = bt.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll('.toggle button'), function (o) { o.setAttribute('aria-pressed', o === bt); });
      Array.prototype.forEach.call($('grid').children, setView);
    };
  });

  var WORDS = {
    PATTERN: ['Found a repeating pattern', 'red'],
    LATTICE: ['Found a grid on the block lattice', 'red'],
    WEAK: ['Something, but it does not hold up', 'black'],
    CLEAN: ['No strong pattern found', 'black']
  };
  // FNV-1a 32 over the analysed RGB bytes: lets a test prove the page read the SAME pixels as the command line
  function fnv1a(b) { var h = 0x811c9dc5; for (var i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }
  function pick(c) { return { period_px: c.period_px, angle_deg: c.angle_deg, max_prominence: c.max_prominence, n_permutations: c.n_permutations, n_crops: c.n_crops, recurs: c.recurs }; }
  function finishOne(secs) {
    var perms = M.PERMS.map(function (p) { return state.perms[p[1]]; });
    var v = M.decide(perms, T, TL);
    state.verdict = v;
    var rec = {}, recL = {};
    v.clusters.forEach(function (c) { if (c.recurs) c.permutations.forEach(function (n) { rec[n] = 1; }); });
    v.lattice_clusters.forEach(function (c) { if (c.recurs) c.permutations.forEach(function (n) { recL[n] = 1; }); });
    Array.prototype.forEach.call($('grid').children, function (cell) {
      var n = cell.dataset.name, tag = rec[n] ? 'RECURS' : (recL[n] ? 'LATTICE' : null);
      if (tag) { var bd = document.createElement('span'); bd.className = 'badge' + (tag === 'LATTICE' ? ' lat' : ''); bd.textContent = tag; cell.querySelector('.pic').appendChild(bd); }
    });
    var w = WORDS[v.verdict], box = $('verdict');
    box.className = 'verdict ' + w[1]; box.hidden = false;
    $('vKick').textContent = 'The answer';
    $('vWord').textContent = w[0];
    var top = (v.clusters.filter(function (c) { return c.recurs; })[0]) || v.clusters[0];
    var lt = v.lattice_clusters.filter(function (c) { return c.recurs; })[0];
    var say;
    // DRAFT COPY (every sentence below)
    if (v.verdict === 'PATTERN') say = 'A repeat every ' + top.period_px.toFixed(2) + ' px at ' + top.angle_deg.toFixed(1) + '\u00b0, standing out up to ' + (top.max_prominence / T).toFixed(1) + 'x past the threshold, in ' + top.n_permutations + ' of the 69 views and ' + top.n_crops + ' of the 4 quarters.' + (top.harmonic_of ? ' (It is harmonic ' + top.harmonic_of.n + ' of a longer ' + top.harmonic_of.period_px.toFixed(2) + ' px repeat.)' : '') + ' That is a fingerprint of how the picture was made. It is not, by itself, proof of hidden data.';
    else if (v.verdict === 'LATTICE') say = 'A strong grid sits exactly on the JPEG 8 / 16 px block lattice: every ' + lt.period_px.toFixed(2) + ' px at ' + lt.angle_deg.toFixed(1) + '\u00b0, in ' + lt.n_permutations + ' views and ' + lt.n_crops + ' quarters. Ordinary JPEG never did this on any clean test picture, but block-aligned content (pixel art, a UI grid, an upscaler) can. It is never counted as PATTERN.';
    else if (v.verdict === 'WEAK') say = 'Something crossed the threshold (' + T.toFixed(2) + ') but it did not recur across 2+ views AND 2+ quarters' + (top ? ' (best: ' + top.period_px.toFixed(2) + ' px at ' + top.angle_deg.toFixed(1) + '\u00b0, ' + top.n_permutations + ' views, ' + top.n_crops + ' quarters)' : '') + '. A long repeat with few cycles per quarter can do this. Treat it as a maybe.';
    else say = 'Nothing crossed the line. The strongest candidate reached a prominence of ' + v.max_candidate_prominence.toFixed(2) + ', and the threshold is ' + T.toFixed(2) + ' (1.25x the strongest thing found in 24 pictures known to be clean). This is "no repeating pattern this meter can see", not "clean": a mark that does not repeat inside one picture is invisible here (try Many images).';
    $('vSay').textContent = say;
    $('vNums').textContent = 'threshold ' + T + ' / lattice ' + TL + ' | max candidate ' + v.max_candidate_prominence.toFixed(3) + (v.max_candidate_where ? ' (' + v.max_candidate_where[0] + ', ' + v.max_candidate_where[1] + ')' : '') + ' | max off-axis lattice ' + v.max_offaxis_lattice_prominence.toFixed(3) + ' | hits ' + v.n_hits + ', clusters ' + v.n_clusters + ' | labelled over T: grid ' + v.grid_peaks_ge_T + ', axis ' + v.axis_peaks_ge_T + ' | ' + state.img.W + ' x ' + state.img.H + ' px, ' + secs.toFixed(1) + ' s';
    var per = {};
    perms.forEach(function (p) { per[p.name] = [p.score.cand, p.score.lattice]; });
    $('verdict').dataset.json = JSON.stringify({ mode: 'one', verdict: v.verdict, W: state.img.W, H: state.img.H, decode: state.decodePath, dither: M.DITHER_KIND, fnv: fnv1a(state.img.rgb),
      max_candidate_prominence: v.max_candidate_prominence, max_candidate_where: v.max_candidate_where, max_offaxis_lattice_prominence: v.max_offaxis_lattice_prominence,
      n_hits: v.n_hits, n_clusters: v.n_clusters, lattice_offaxis_ge_T: v.lattice_offaxis_ge_T, grid_peaks_ge_T: v.grid_peaks_ge_T, axis_peaks_ge_T: v.axis_peaks_ge_T,
      clusters: v.clusters.slice(0, 3).map(pick), lattice_clusters: v.lattice_clusters.slice(0, 3).map(pick), perm: per });
    status('Done. ' + M.PERMS.length + ' views in ' + secs.toFixed(1) + ' s, all on this device.');
    progress(null);
    runExtras();
  }

  var EXTRAS = [['gamma25', 'Darks lifted (gamma 0.25)'], ['gamma50', 'Darks lifted (gamma 0.5)'], ['sat999', 'Saturation x999'],
    ['levels', 'Auto levels (colour)'], ['equalize', 'Equalized (colour)'], ['chroma', 'Chroma residual x24'], ['residual', 'Fine-grain residual x12']];
  function runExtras() {
    var my = runId;
    $('extrasWrap').hidden = false;
    EXTRAS.forEach(function (e) {
      queue({ cmd: 'extra', kind: e[0], thumb: 240, maxSide: 1400 }).then(function (r) {
        if (my !== runId) return;
        state.extras[e[0]] = r;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'cell';
        var pic = document.createElement('span'); pic.className = 'pic'; var cv = document.createElement('canvas'); putPack(cv, r.thumb); pic.appendChild(cv);
        var lab = document.createElement('span'); lab.className = 'lab'; lab.innerHTML = '<span class="t"></span><span class="s">not scored</span>';
        lab.querySelector('.t').textContent = e[1];
        b.appendChild(pic); b.appendChild(lab);
        b.onclick = function () { openExtra(e[1], r); };
        $('extras').appendChild(b);
      });
    });
  }

  // ------------------------------------------------------------------ the enlarged view
  function fitCanvas(cv) { cv.style.width = '100%'; cv.style.height = 'auto'; }
  function openDetail(name) {
    var r = state.perms[name], dlg = $('dlg');
    $('dTitle').textContent = name;
    $('dWhy').textContent = 'Working...';
    ['dPic', 'dSpec', 'dAc'].forEach(function (id) { var c = $(id); c.width = 1; c.height = 1; c.parentNode.parentNode.hidden = false; });
    $('dPeaks').innerHTML = '';
    if (!dlg.open) dlg.showModal();
    send(idle(), { cmd: 'detail', name: name, maxSide: 1200 }).then(function (d) {
      putPack($('dPic'), d.view); fitCanvas($('dPic'));
      if (d.spec) { putPack($('dSpec'), d.spec); fitCanvas($('dSpec')); drawRings($('dSpec'), d); }
      if (d.ac) { putPack($('dAc'), d.ac); fitCanvas($('dAc')); $('dAcCap').textContent = 'Autocorrelation, lags up to +-' + d.acSpan.lagX + ' x +-' + d.acSpan.lagY + ' px: a repeat shows as a regular lattice of spots.'; }
      var sc = r.score;
      $('dWhy').textContent = r.family + ' - score ' + sc.score.toFixed(2) + ' (1.00 = threshold). Best candidate prominence ' + sc.cand.toFixed(2) + (sc.cand_where ? ' at ' + sc.cand_where[1].toFixed(2) + ' px / ' + sc.cand_where[2].toFixed(1) + '\u00b0 in ' + sc.cand_where[0] : '') + '; best off-axis lattice ' + sc.lattice.toFixed(2) + '.';
      var rows = '<tr><th>#</th><th>period px</th><th>angle</th><th>prominence</th><th>kind</th></tr>';
      d.peaks.slice(0, 14).forEach(function (p, i) {
        var kind = p.label === 'candidate' ? (p.prominence >= T ? 'candidate, over threshold' : 'candidate') : (p.label + (p.why ? ' (' + p.why + ')' : '') + (p.offaxis ? ', off-axis lattice' : ''));
        rows += '<tr><td>' + (i + 1) + '</td><td>' + p.period_px.toFixed(3) + '</td><td>' + p.angle_deg.toFixed(1) + '\u00b0</td><td>' + p.prominence.toFixed(2) + '</td><td>' + kind + '</td></tr>';
      });
      $('dPeaks').innerHTML = '<caption style="text-align:left;color:var(--ash);padding-bottom:6px">Strongest spectrum peaks, whole picture</caption>' + rows;
    }).catch(function (e) { $('dWhy').textContent = 'Could not draw this one: ' + e.message; });
  }
  function drawRings(cv, d) {
    var ctx = cv.getContext('2d'), w = d.full.w, h = d.full.h, sx = cv.width / w, sy = cv.height / h;
    d.peaks.slice(0, 12).forEach(function (p) {
      var col = p.label === 'candidate' ? (p.prominence >= T ? '#ff2828' : '#ffd200') : '#3c8cff';
      var cx = ((p.ix + Math.floor(w / 2)) % w) * sx, cy = ((p.iy + Math.floor(h / 2)) % h) * sy, rr = Math.max(5, cv.width / 90);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, cv.width / 400);
      [[cx, cy], [cv.width - cx, cv.height - cy]].forEach(function (q) { ctx.beginPath(); ctx.arc(q[0], q[1], rr, 0, 2 * Math.PI); ctx.stroke(); });
    });
  }
  function openExtra(title, r) {
    $('dTitle').textContent = title; $('dWhy').textContent = 'An extra look, not scored: it never changes the answer.';
    putPack($('dPic'), r.view); fitCanvas($('dPic'));
    $('dSpec').parentNode.parentNode.hidden = true; $('dAc').parentNode.parentNode.hidden = true; $('dPeaks').innerHTML = '';
    if (!$('dlg').open) $('dlg').showModal();
  }
  $('dClose').onclick = function () { $('dlg').close(); };
  $('dlg').addEventListener('click', function (e) { if (e.target === $('dlg')) $('dlg').close(); });

  // ------------------------------------------------------------------ MANY IMAGES (phase coherence)
  var manyFiles = [];
  function setMany(files) {
    manyFiles = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name); })
      .sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    $('manyInfo').textContent = manyFiles.length ? manyFiles.length + ' pictures chosen' : '';
    $('runMany').disabled = manyFiles.length < 2;
  }
  $('runMany').onclick = function () { runMany(manyFiles); };
  function runMany(files) {
    var my = ++runId;
    $('verdict').hidden = true; $('results').hidden = true; $('multi').hidden = true; $('src').hidden = true;
    delete $('verdict').dataset.json;
    makePool(1);
    var w = pool[0], H = null, W = null, sizes = {}, k = 0, notes = {};
    status('Checking sizes...'); progress(0);
    // pass 1: sizes (never resized; mixed sizes are refused, like the Python)
    var chain = Promise.resolve();
    files.forEach(function (f) {
      // the STORED size (EXIF orientation ignored, like the Python and like decode()): a rotated phone JPEG must not
      // count as W x H here and arrive as H x W later (that garbled the set before Oct 14 2026)
      chain = chain.then(function () { return sizeOf(f).then(function (z) { var key = z.W + ' x ' + z.H; (sizes[key] = sizes[key] || []).push(f.name); }); });
    });
    chain.then(function () {
      var keys = Object.keys(sizes);
      if (keys.length > 1) throw new Error('These are not all one size, and this test never resizes: ' + keys.map(function (s) { return s + ' (' + sizes[s].length + ')'; }).join(', ') + '. Pick one size.');
      var wh = keys[0].split(' x '); W = +wh[0]; H = +wh[1];
      if (Math.min(W, H) < 64) throw new Error('Too small: ' + keys[0] + '.');
      if (W * H > 2400000) throw new Error(keys[0] + ' is too big for the in-browser set test (the limit is about 2.4 megapixels, e.g. 1536 x 1536).');
      return send(w, { cmd: 'coh-start', H: H, W: W });
    }).then(function () {
      var t0 = performance.now(), feed = Promise.resolve();
      files.forEach(function (f, i) {
        feed = feed.then(function () {
          if (my !== runId) throw new Error('cancelled');
          return decode(f).then(function (img) {
            if (img.W !== W || img.H !== H) throw new Error(f.name + ' decoded as ' + img.W + ' x ' + img.H + ', not ' + W + ' x ' + H + ' like the rest of the set. Nothing was computed from a mismatched picture; take it out and run again.');
            if (img.notes.length) notes[img.notes.join(' ')] = (notes[img.notes.join(' ')] || 0) + 1;
            return send(w, { cmd: 'coh-feed', rgb: img.rgb.buffer, W: img.W, H: img.H }, [img.rgb.buffer]);
          })
            .then(function () { k++; progress(k / files.length); status('Lining up phases: ' + k + ' / ' + files.length + ' (' + ((performance.now() - t0) / 1000).toFixed(0) + ' s)'); });
        });
      });
      return feed.then(function () { return send(w, { cmd: 'coh-eval' }); }).then(function (r) { showMany(r, (performance.now() - t0) / 1000, notes); });
    }).catch(function (e) { if (my === runId) { status(e.message || String(e), true); progress(null); } });
  }
  function showMany(r, secs, notes) {
    var ev = r.ev, box = $('verdict'), anch = ev.n_anch > 0, dv = ev.diversity;
    box.className = 'verdict ' + (anch ? 'red' : 'black'); box.hidden = false;
    $('vKick').textContent = 'The answer (' + ev.N + ' pictures, ' + ev.W + ' x ' + ev.H + ')';
    // DRAFT COPY (every sentence below)
    var word, say;
    if (ev.underpowered) { word = 'Not enough pictures'; say = 'With ' + ev.N + ' pictures no frequency can pass the test (it needs agreement above ' + ev.cstar.toFixed(3) + ', which is impossible). Use at least ' + ev.n_min + ' pictures of this size. This is NOT a clean result.'; }
    else if (anch) { word = ev.n_anch + ' fixed signal' + (ev.n_anch === 1 ? '' : 's') + ' line up'; say = ev.n_anch + ' frequencies have the same phase in picture after picture: something is fixed in image coordinates across this set. A watermark does this (Google\'s SynthID showed 24 to 27 such frequencies in 98 Gemini images). So does any shared content: a fixed scene, a border, a vignette, a decoder fingerprint. Only a test against matched pictures from another source can tell those apart.'; }
    else if (ev.n_grid > 0) { word = 'Nothing off the grid'; say = 'No fixed signal lines up off the 8 / 16 px grid, at this number of pictures (it can see agreement above ' + ev.cstar.toFixed(3) + '). Some frequencies ON the grid line up, which is what decoders and JPEG seams do, and a mark hidden there would be invisible to this test. Not "clean": a mark keyed to each picture would not show here either.'; }
    else { word = 'Nothing lines up'; say = 'No fixed signal lines up across these pictures, at this number of pictures (it can see agreement above ' + ev.cstar.toFixed(3) + '). Not "clean": a mark keyed to each picture, or one that adapts to the content, would not show here.'; }
    if (dv.warn) say += ' WARNING: these pictures share most of their content (similarity ' + dv.rho_res.toFixed(2) + ' / ' + dv.rho_raw.toFixed(2) + '), so anything that lines up could just be that content.';
    var nk = Object.keys(notes || {});
    if (nk.length) say += ' ' + nk.map(function (t) { return '(' + notes[t] + ' picture' + (notes[t] === 1 ? '' : 's') + ') ' + t; }).join(' ');
    $('vWord').textContent = word; $('vSay').textContent = say;
    $('verdict').dataset.json = JSON.stringify({ mode: 'many', verdict: ev.verdict, N: ev.N, W: ev.W, H: ev.H, n_anch: ev.n_anch, n_grid: ev.n_grid, n_shared: ev.n_shared,
      n_grid_anchored: ev.n_grid_anchored, cstar: ev.cstar, tests: ev.tests, counts: ev.counts, rho_res: dv.rho_res, rho_raw: dv.rho_raw, warn: dv.warn,
      top_bins: ev.bins.slice(0, 10), shift_kind: M.DITHER_KIND });
    $('vNums').textContent = 'verdict ' + ev.verdict + ' | N ' + ev.N + ' | detection floor C* ' + ev.cstar.toFixed(4) + ' (Rayleigh, Bonferroni over ' + ev.tests.toLocaleString() + ' tests, alpha ' + ev.alpha + ') | grid-band shift-dead bins ' + ev.n_grid_anchored + ' (the blind band is ' + (100 * ev.grid_blind_fraction).toFixed(1) + '% of all bins) | shift-surviving ' + ev.n_shared + ' | content similarity ' + dv.rho_res.toFixed(3) + ' residual / ' + dv.rho_raw.toFixed(3) + ' raw (independent ~' + (dv.independent_expectation || 0).toFixed(3) + ') | ' + secs.toFixed(1) + ' s';
    $('multi').hidden = false;
    var t = '<tr><th>channel</th><th>anchored off-grid</th><th>on the grid</th><th>grid, shift-dead</th><th>shift-surviving</th></tr>';
    Object.keys(ev.counts).forEach(function (c) { var q = ev.counts[c]; t += '<tr><td>' + c + '</td><td>' + q.anchored_offgrid + '</td><td>' + q.grid + '</td><td>' + q.grid_anchored + '</td><td>' + q.shared_offgrid + '</td></tr>'; });
    $('mTable').innerHTML = t;
    putPack($('cohPic'), r.pic); $('cohPic').style.width = '100%'; $('cohPic').style.height = 'auto';
    // ring every listed anchored bin (and its mirror): one bin is one pixel, too small to see on its own
    var cp = $('cohPic'), cx2 = cp.getContext('2d'), kx = cp.width / ev.W, ky = cp.height / ev.H, rr = Math.max(6, cp.width / 70);
    cx2.strokeStyle = '#ff2828'; cx2.lineWidth = Math.max(2, cp.width / 350);
    ev.bins.forEach(function (q) {
      [[q.fx, q.fy], [-q.fx, -q.fy]].forEach(function (f) {
        var px = (((f[0] + Math.floor(ev.W / 2)) % ev.W) + ev.W) % ev.W, py = (((f[1] + Math.floor(ev.H / 2)) % ev.H) + ev.H) % ev.H;
        cx2.beginPath(); cx2.arc((px + 0.5) * kx, (py + 0.5) * ky, rr, 0, 2 * Math.PI); cx2.stroke();
      });
    });
    var b = '<caption style="text-align:left;color:var(--ash);padding:10px 0 6px">Strongest anchored frequencies</caption><tr><th>channel</th><th>fy, fx (cycles / picture)</th><th>period px</th><th>angle</th><th>agreement C</th></tr>';
    ev.bins.slice(0, 20).forEach(function (q) { b += '<tr><td>' + q.ch + '</td><td>' + q.fy + ', ' + q.fx + '</td><td>' + q.period_px.toFixed(2) + '</td><td>' + q.angle_deg.toFixed(1) + '\u00b0</td><td>' + q.C.toFixed(3) + '</td></tr>'; });
    $('mBins').innerHTML = ev.bins.length ? b : '';
    status('Done. ' + ev.N + ' pictures in ' + secs.toFixed(1) + ' s, all on this device.'); progress(null);
  }

  // ------------------------------------------------------------------ inputs
  function wireDrop(zone, input, onFiles) {
    input.addEventListener('change', function () { if (input.files.length) onFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files); });
  }
  wireDrop($('drop1'), $('file1'), function (fs) { runOne(fs[0]); });
  wireDrop($('drop2'), $('file2'), function (fs) { setMany(fs); });
  if (!window.HPDecode) status('The page did not load completely (decode.js is missing).', true);
  else if (!window.Worker || !window.createImageBitmap) status('This browser cannot run the finder (it needs Web Workers and createImageBitmap).', true);
})();

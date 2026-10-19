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
    $('tab-fp').setAttribute('aria-selected', which === 'fp');
    $('one').hidden = which !== 'one'; $('many').hidden = which !== 'many'; $('fp').hidden = which !== 'fp';
    // the CSS shows the One/Many result panels only outside the Fingerprint tab and #fpOut only inside it; nothing's
    // own hidden flag is touched, so results come back as they were when you switch back (port, Oct 17 2026)
    document.body.classList.toggle('fpmode', which === 'fp');
  }
  $('tab-one').onclick = function () { tab('one'); };
  $('tab-many').onclick = function () { tab('many'); };
  $('tab-fp').onclick = function () { tab('fp'); };

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
      var base = { name: file.name, bytes: file.size, notes: notes, kind: info.type, fileBytes: bytes };
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
  // THE ONE RESIZE RULE (Oct 17 2026; meter.js deviation D6, closed): the same as the command line's int_reduce(), bit
  // for bit. Long side <= cap: no resize at all. Above it, k = ceil(long side / cap): W and H are cropped DOWN to
  // multiples of k (the right/bottom remainder is dropped and reported), and each output channel is the integer mean of
  // its k x k block, (sum + floor(k*k/2)) / (k*k) floored. Why a whole number: a block-lattice frequency f (a multiple of
  // 1/8 cycles per px) becomes k*f mod 1 in the smaller pixels, still a multiple of 1/8, so the JPEG/WebP block grid stays
  // ON the lattice and keeps its label. The old area average by a non-integer factor moved it off the lattice, where it
  // turned into a false "candidate" (a Nano Banana 2 picture read WEAK at 5.03 px here and CLEAN on the command line).
  function intReduceRGB(img, cap) {
    var W = img.W, H = img.H, m = Math.max(W, H);
    if (m <= cap) return img;
    var k = Math.ceil(m / cap), tw = Math.floor(W / k), th = Math.floor(H / k), kk = k * k, half = Math.floor(kk / 2);
    var out = new Uint8Array(tw * th * 3), src = img.rgb;
    for (var ty = 0; ty < th; ty++) {
      for (var tx = 0; tx < tw; tx++) {
        var r = 0, g = 0, b = 0;
        for (var y = ty * k; y < ty * k + k; y++) {
          var i = 3 * (y * W + tx * k);
          for (var x = 0; x < k; x++, i += 3) { r += src[i]; g += src[i + 1]; b += src[i + 2]; }
        }
        var o = 3 * (ty * tw + tx);
        out[o] = Math.floor((r + half) / kk); out[o + 1] = Math.floor((g + half) / kk); out[o + 2] = Math.floor((b + half) / kk);
      }
    }
    return { rgb: out, W: tw, H: th, name: img.name, bytes: img.bytes, notes: img.notes, path: img.path,
      reduced: { k: k, from: [W, H], to: [tw, th], dropped_px: { right: W - tw * k, bottom: H - th * k }, filter: 'integer-block-mean' } };
  }
  function sizeWord(k) { return k === 2 ? 'half' : (k === 3 ? 'a third' : (k === 4 ? 'a quarter' : '1/' + k)); }
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
  var WM_MAX_PX = 40000000; // the DWT-DCT reader's full-size copy: 40 MP = 120 MB (port, Oct 17 2026)
  function runOne(file) {
    var my = ++runId, cap = +$('cap').value;
    $('verdict').hidden = true; $('results').hidden = true; $('multi').hidden = true; $('extrasWrap').hidden = true; $('facts').hidden = true;
    $('grid').innerHTML = ''; $('extras').innerHTML = '';
    state = { perms: {}, view: state.view, extras: {}, img: null, verdict: null, decodePath: null };
    delete $('verdict').dataset.json;
    status('Reading ' + file.name + ' on this device...'); progress(0);
    decode(file).then(function (raw) {
      if (my !== runId) return;
      var img = intReduceRGB(raw, cap);
      if (Math.min(img.W, img.H) < 192) throw new Error('This picture is ' + img.W + ' x ' + img.H + ' px. It needs at least 192 px on its short side (four quarters of 96 px each).');
      state.img = img;
      $('src').hidden = false; drawRGB($('srcCanvas'), img, 160);
      var rd = img.reduced, dropped = rd ? rd.dropped_px.right + rd.dropped_px.bottom : 0;
      $('srcInfo').textContent = raw.name + ' - ' + raw.W + ' x ' + raw.H + ' px' + (rd ? ' (analysed at ' + sizeWord(rd.k) + ' size, ' + img.W + ' x ' + img.H + ': every ' + rd.k + ' x ' + rd.k + ' block of pixels averaged into one' + (dropped ? ', after trimming ' + (rd.dropped_px.right ? rd.dropped_px.right + ' px off the right' : '') + (rd.dropped_px.right && rd.dropped_px.bottom ? ' and ' : '') + (rd.dropped_px.bottom ? rd.dropped_px.bottom + ' px off the bottom' : '') + ' so the blocks fit' : '') + '. Periods are in those smaller pixels: multiply them by ' + rd.k + ' for the original.)' : ' (analysed at full size)') + (raw.notes.length ? ' ' + raw.notes.join(' ') : '');
      state.decodePath = raw.path;
      showFacts(raw, my);
      makePool(NW);
      return Promise.all(pool.map(function (s) { return send(s, { cmd: 'init', rgb: img.rgb.buffer.slice(0), H: img.H, W: img.W }); })).then(function () {
        // the DWT-DCT reader needs the file's own pixels, not the analysis-size copy: one more full-size copy (3 bytes
        // per pixel), so it runs only up to WM_MAX_PX
        if (raw.W * raw.H > WM_MAX_PX) { setList($('wmList'), [{ what: 'Not read: this picture is ' + (raw.W * raw.H / 1e6).toFixed(1) + ' megapixels, and the reader runs on pictures up to ' + (WM_MAX_PX / 1e6) + ' megapixels here (it needs its own full-size copy). The mark is fragile anyway: a picture this big has usually not been through a generator untouched.' }]); return; }
        queue({ cmd: 'wm', rgb: raw.rgb.buffer.slice(0), H: raw.H, W: raw.W }).then(function (r) { if (my === runId) showWm(r.wm); }, function (e) { if (my === runId) setList($('wmList'), [{ what: 'Could not read: ' + e.message }]); });
      });
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

  // the WEAK reasons and the block-grid note (Oct 17 2026) live in meter.js (M.weakSay / M.gridSay) so the test harness can
  // call them directly; see there.
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
    else if (v.verdict === 'WEAK') say = M.weakSay(top, T, Math.floor(Math.min(state.img.W, state.img.H) / 2));
    else say = 'Nothing crossed the line. The strongest candidate reached a prominence of ' + v.max_candidate_prominence.toFixed(2) + ', and the threshold is ' + T.toFixed(2) + ' (1.25x the strongest thing found in 24 pictures known to be clean). This is "no repeating pattern this meter can see", not "clean": a mark that does not repeat inside one picture is invisible here (try Many images).';
    $('vSay').textContent = say;
    var bg = M.blockGrid(perms, T), gs = M.gridSay(bg, v.verdict);
    $('vGrid').textContent = gs; $('vGrid').hidden = !gs;
    $('vNums').textContent = 'threshold ' + T + ' / lattice ' + TL + ' | max candidate ' + v.max_candidate_prominence.toFixed(3) + (v.max_candidate_where ? ' (' + v.max_candidate_where[0] + ', ' + v.max_candidate_where[1] + ')' : '') + ' | max off-axis lattice ' + v.max_offaxis_lattice_prominence.toFixed(3) + ' | hits ' + v.n_hits + ', clusters ' + v.n_clusters + ' | labelled over T: grid ' + v.grid_peaks_ge_T + ', axis ' + v.axis_peaks_ge_T + ' | ' + state.img.W + ' x ' + state.img.H + ' px, ' + secs.toFixed(1) + ' s';
    var per = {};
    perms.forEach(function (p) { per[p.name] = [p.score.cand, p.score.lattice]; });
    $('verdict').dataset.json = JSON.stringify({ mode: 'one', verdict: v.verdict, W: state.img.W, H: state.img.H, decode: state.decodePath, dither: M.DITHER_KIND, fnv: fnv1a(state.img.rgb),
      max_candidate_prominence: v.max_candidate_prominence, max_candidate_where: v.max_candidate_where, max_offaxis_lattice_prominence: v.max_offaxis_lattice_prominence,
      n_hits: v.n_hits, n_clusters: v.n_clusters, lattice_offaxis_ge_T: v.lattice_offaxis_ge_T, grid_peaks_ge_T: v.grid_peaks_ge_T, axis_peaks_ge_T: v.axis_peaks_ge_T,
      clusters: v.clusters.slice(0, 3).map(pick), lattice_clusters: v.lattice_clusters.slice(0, 3).map(pick), perm: per,
      block_grid: bg, reduced: state.img.reduced || null, cap: +$('cap').value, say: say, grid_say: gs });
    status('Done. ' + M.PERMS.length + ' views in ' + secs.toFixed(1) + ' s, all on this device.');
    progress(null);
    runExtras();
  }

  // ------------------------------------------------------------------ what the file says (meta.js) + the DWT-DCT reader (wmdecode.js)
  function setList(ul, items) {
    ul.innerHTML = '';
    items.forEach(function (it) { var li = document.createElement('li'); if (it.strong) li.className = 'strong'; li.textContent = it.what; if (it.sub) { var d = document.createElement('div'); d.className = 'bits'; d.textContent = it.sub; li.appendChild(d); } ul.appendChild(li); });
  }
  function showFacts(raw, my) {
    // the metadata reader must never stop the pattern analysis: a throw, a rejection or a missing meta.js only shows
    // up in this panel (port, Oct 17 2026)
    var bytes = raw.fileBytes; delete raw.fileBytes; // the analysis copy must not keep the whole file alive
    $('facts').hidden = false;
    setList($('metaList'), [{ what: 'Reading...' }]); setList($('wmList'), [{ what: 'Reading...' }]);
    var fail = function (e) { if (my === runId) setList($('metaList'), [{ what: 'Could not read the metadata: ' + (e && e.message || e) }]); };
    try {
      if (!window.HPMeta) throw new Error('the metadata reader (meta.js) did not load');
      window.HPMeta.read(bytes).then(function (m) {
        if (my !== runId) return;
        var items = m.flags.slice();
        if (m.c2pa && m.c2pa.is_c2pa && m.c2pa.actions.length) items.push({ what: 'C2PA actions: ' + m.c2pa.actions.join(', ') });
        if (m.xmp) ['xmp:CreatorTool', 'tiff:Software', 'photoshop:Credit'].forEach(function (k) { if (m.xmp[k]) items.push({ what: 'XMP ' + k + ' = ' + m.xmp[k] }); });
        if (m.exif) ['Make', 'Model', 'Artist'].forEach(function (k) { if (m.exif[k]) items.push({ what: 'EXIF ' + k + ' = ' + m.exif[k] }); });
        (m.text || []).forEach(function (t) { if (!m.flags.some(function (f) { return f.what.indexOf('"' + t.key + '"') >= 0; })) items.push({ what: 'PNG text "' + t.key + '" = ' + t.value.slice(0, 160) + (t.value.length > 160 ? '...' : '') + (t.cut ? ' (only the first 1 MB was unpacked)' : '') }); });
        if (m.error) items.push({ what: 'The file\'s structure could not be read to the end (' + m.error + '); what is listed came before that point.' });
        if (!items.length) items.push({ what: 'Nothing: no C2PA, no AI source type, no generator text, no EXIF software (' + m.format.toUpperCase() + '). That proves nothing either way.' });
        else if (!m.ai_declared) items.push({ what: 'Nothing here declares the picture AI-made (no trained-model source type, no generator settings).' });
        setList($('metaList'), items);
      }).catch(fail);
    } catch (e) { fail(e); }
  }
  function showWm(w) {
    if (w.error) { setList($('wmList'), [{ what: w.error }]); return; }
    var items = w.known.map(function (k) {
      var hit = k.p < 1e-6;
      return { strong: hit, what: (hit ? 'FOUND: ' : '') + k.name + ': ' + k.match + ' of ' + k.L + ' bits match (chance of that many by luck: ' + (k.p < 1e-12 ? '< 1e-12' : k.p.toPrecision(2)) + ')',
        sub: 'read ' + (k.text != null ? '"' + k.text + '" = ' : '') + '0x' + k.hex + ', ' + k.blocks_per_bit.toFixed(1) + ' blocks per bit' };
    });
    items.push({ what: w.verdict === 'NO-MATCH' ? 'No known DWT-DCT payload. Expected on most pictures: the mark is fragile, and most generators don\'t use it.' : 'A known open watermark is in this picture.' });
    setList($('wmList'), items);
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
  var ctlFiles = [];
  function setCtl(files) {
    ctlFiles = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name); })
      .sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    $('ctlInfo').textContent = ctlFiles.length ? ctlFiles.length + ' control pictures' : '';
    $('clearCtl').hidden = !ctlFiles.length;
  }
  $('clearCtl').onclick = function () { setCtl([]); };
  $('runMany').onclick = function () { runMany(manyFiles, ctlFiles); };
  // 1536 x 2816 (4.33 MP) fits (Oct 17 2026; was 2.4 MP). Worker memory at the limit, estimated: the set's sums about
  // 330 MB (float32), a control's about 110 MB (lite: phases only), one picture in flight about 430 MB: under 1 GB.
  var MANY_MAX_PX = 4500000;
  function runMany(files, ctl) {
    ctl = ctl || [];
    var my = ++runId;
    $('verdict').hidden = true; $('results').hidden = true; $('multi').hidden = true; $('src').hidden = true; $('facts').hidden = true;
    delete $('verdict').dataset.json;
    makePool(1);
    var w = pool[0], H = null, W = null, sizes = {}, k = 0, notes = {};
    status('Checking sizes...'); progress(0);
    // pass 1: sizes (never resized; mixed sizes are refused, like the Python)
    var chain = Promise.resolve();
    files.concat(ctl).forEach(function (f) {
      // the STORED size (EXIF orientation ignored, like the Python and like decode()): a rotated phone JPEG must not
      // count as W x H here and arrive as H x W later (that garbled the set before Oct 14 2026)
      chain = chain.then(function () { return sizeOf(f).then(function (z) { var key = z.W + ' x ' + z.H; (sizes[key] = sizes[key] || []).push(f.name); }); });
    });
    chain.then(function () {
      var keys = Object.keys(sizes);
      if (keys.length > 1) throw new Error('These are not all one size' + (ctl.length ? ' (set and control together)' : '') + ', and this test never resizes: ' + keys.map(function (s) { return s + ' (' + sizes[s].length + ')'; }).join(', ') + '. Pick one size.');
      var wh = keys[0].split(' x '); W = +wh[0]; H = +wh[1];
      if (Math.min(W, H) < 64) throw new Error('Too small: ' + keys[0] + '.');
      if (W * H > MANY_MAX_PX) throw new Error(keys[0] + ' is too big for the in-browser set test (the limit is about 4.5 megapixels, e.g. 1536 x 2816).');
      return send(w, { cmd: 'coh-start', which: 'set', H: H, W: W }).then(function () { if (ctl.length) return send(w, { cmd: 'coh-start', which: 'control', H: H, W: W }); });
    }).then(function () {
      var t0 = performance.now(), feed = Promise.resolve(), all = files.map(function (f) { return [f, 'set']; }).concat(ctl.map(function (f) { return [f, 'control']; }));
      all.forEach(function (fw, i) {
        var f = fw[0];
        feed = feed.then(function () {
          if (my !== runId) throw new Error('cancelled');
          return decode(f).then(function (img) {
            if (img.W !== W || img.H !== H) throw new Error(f.name + ' decoded as ' + img.W + ' x ' + img.H + ', not ' + W + ' x ' + H + ' like the rest of the set. Nothing was computed from a mismatched picture; take it out and run again.');
            if (img.notes.length) notes[img.notes.join(' ')] = (notes[img.notes.join(' ')] || 0) + 1;
            return send(w, { cmd: 'coh-feed', which: fw[1], rgb: img.rgb.buffer, W: img.W, H: img.H }, [img.rgb.buffer]);
          })
            .then(function () { k++; progress(k / all.length); status('Lining up phases: ' + k + ' / ' + all.length + (ctl.length ? ' (set + control)' : '') + ' (' + ((performance.now() - t0) / 1000).toFixed(0) + ' s)'); });
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
    var word, say, cmT = r.cmp ? r.cmp.n_set_only + r.cmp.n_set_only_grid + r.cmp.n_same + r.cmp.n_undecided + r.cmp.n_untestable : 0;
    // the control branch runs when the control can test something: it is big enough, or (rarely) it flagged a frequency
    // anyway because the control lines up there with a DIFFERENT phase
    var ctlUsed = !!(r.cmp && cmT > 0 && (!r.cmp.underpowered || r.cmp.n_set_only + r.cmp.n_set_only_grid > 0));
    if (ev.underpowered) { word = 'Not enough pictures'; say = 'With ' + ev.N + ' pictures no frequency can pass the test (it needs agreement above ' + ev.cstar.toFixed(3) + ', which is impossible). Use at least ' + ev.n_min + ' pictures of this size. This is NOT a clean result.'; }
    else if (ctlUsed) {
      // the control can test something: every anchored set frequency is set-only, the same in the control (the control
      // itself lines up there), undecided (strong enough, but the control does not line up there and the test could not
      // tell), or too faint for THIS control to tell (cohCompare's power rule). A small or noisy control never reads as
      // "nothing beyond the control" (fix, Oct 17 2026: undecided ones used to be counted as "same").
      var cm = r.cmp, nso = cm.n_set_only + cm.n_set_only_grid;
      box.className = 'verdict ' + (nso ? 'red' : 'black');
      var faint = !cm.n_untestable ? '' : cm.underpowered ? ' ' + cm.n_untestable + ' more line up in the set, but ' + cm.Nb + ' control pictures are too few to test them' + (cm.nb_min ? ' (use at least ' + cm.nb_min + ')' : '') + '.' :
        ' ' + cm.n_untestable + ' more line up in the set but are too faint for ' + cm.Nb + ' control pictures to tell apart (that needs agreement above ' + cm.cstar_ctl.toFixed(3) + ' off the grid; more control pictures lower it).';
      if (cm.n_undecided) faint += ' ' + cm.n_undecided + ' more line up in the set and are strong enough to test, but the control does not line up there and the test could not tell them apart from it: undecided, so more control pictures are needed.';
      if (nso) { word = nso + ' signal' + (nso === 1 ? '' : 's') + ' only in this set'; say = cm.n_set_only + ' off-grid and ' + cm.n_set_only_grid + ' grid frequencies line up across this set AND differ from the ' + cm.Nb + ' control pictures (two-sample test, alpha 0.01 over ' + cm.tests.toLocaleString() + ' tests; grid ones 100x stricter). Something fixed in image coordinates is in this set and not in the control. A watermark does that; so does a fingerprint that only this source has (its decoder, its upscaler). It is not, by itself, proof of a watermark.' + faint; }
      else if (cm.n_same && !cm.n_undecided) { word = 'Nothing beyond the control'; say = cm.n_same + ' frequencies line up in this set and were strong enough to test, and the ' + cm.Nb + ' control pictures line up in a similar way there too, so they are something both sources share.' + faint + ' Not "clean": a mark keyed to each picture, or one that adapts to the content, would not show here.'; }
      else { word = 'Control too small to tell'; say = (cm.n_untestable + cm.n_undecided) + ' frequencies line up in this set, but ' + cm.Nb + ' control pictures cannot tell them apart from the control' +
        (cm.n_untestable ? ': ' + cm.n_untestable + ' are too faint (that needs agreement above ' + cm.cstar_ctl.toFixed(3) + ' off the grid, ' + cm.cstar_ctl_grid.toFixed(3) + ' on it)' : '') +
        (cm.n_undecided ? (cm.n_untestable ? ', and ' : ': ') + cm.n_undecided + ' are strong enough to test, but the control does not line up there and the test could not tell either way' : '') +
        (cm.n_same ? '. (' + cm.n_same + ' more line up in the control in a similar way, so those are something both sources share.)' : '.') +
        ' This is NOT "nothing beyond the control": add control pictures and run again.'; }
    }
    else if (anch) { word = ev.n_anch + ' fixed signal' + (ev.n_anch === 1 ? '' : 's') + ' line up'; say = ev.n_anch + ' frequencies have the same phase in picture after picture: something is fixed in image coordinates across this set. A watermark does this. So does any shared content: a fixed scene, a border, a vignette, a decoder fingerprint. Add a control set from another source (same size) to tell those apart.'; }
    else if (ev.n_grid_strict > 0) { word = ev.n_grid_strict + ' on the grid'; say = 'Nothing lines up off the 8 / 16 px grid, but ' + ev.n_grid_strict + ' grid frequencies pass the stricter test (agreement above ' + ev.cstar_grid.toFixed(3) + ', 100x stricter than off the grid). Block-based marks (like the open DWT-DCT watermark) live there, and so do JPEG seams and decoders: add a control set of the same size to tell them apart.'; }
    else if (ev.n_grid > 0) { word = 'Nothing off the grid'; say = 'No fixed signal lines up off the 8 / 16 px grid, at this number of pictures (it can see agreement above ' + ev.cstar.toFixed(3) + '). Some frequencies ON the grid line up a little, which is what decoders and JPEG seams do, but none passes the stricter grid test (' + ev.cstar_grid.toFixed(3) + '). Not "clean": a mark keyed to each picture would not show here either.'; }
    else { word = 'Nothing lines up'; say = 'No fixed signal lines up across these pictures, at this number of pictures (it can see agreement above ' + ev.cstar.toFixed(3) + '). Not "clean": a mark keyed to each picture, or one that adapts to the content, would not show here.'; }
    if (r.cmp && r.cmp.underpowered && !ctlUsed) say += ' A control of ' + r.cmp.Nb + ' pictures was given, but it is too small to test against: no frequency could ever pass (that would need agreement above ' + r.cmp.cstar_ctl.toFixed(3) + ', which is impossible)' + (r.cmp.nb_min ? '. Use at least ' + r.cmp.nb_min + ' control pictures with this set' : '') + '. So the words above are the set on its own.';
    else if (r.cmp && !cmT) say += ' (The ' + r.cmp.Nb + ' control pictures were not needed: nothing in the set lines up to compare.)';
    if (dv.warn) say += ' WARNING: these pictures share most of their content (similarity ' + dv.rho_res.toFixed(2) + ' / ' + dv.rho_raw.toFixed(2) + '), so anything that lines up could just be that content.';
    var nk = Object.keys(notes || {});
    if (nk.length) say += ' ' + nk.map(function (t) { return '(' + notes[t] + ' picture' + (notes[t] === 1 ? '' : 's') + ') ' + t; }).join(' ');
    $('vWord').textContent = word; $('vSay').textContent = say; $('vGrid').hidden = true; $('vGrid').textContent = '';
    $('verdict').dataset.json = JSON.stringify({ mode: 'many', verdict: ev.verdict, N: ev.N, W: ev.W, H: ev.H, n_anch: ev.n_anch, n_grid: ev.n_grid, n_grid_strict: ev.n_grid_strict, n_shared: ev.n_shared,
      grid_strict_verdict: ev.grid_strict_verdict, cstar_grid: ev.cstar_grid,
      control: r.cmp ? { N: r.cmp.Nb, n_set_only: r.cmp.n_set_only, n_set_only_grid: r.cmp.n_set_only_grid, n_same: r.cmp.n_same, n_undecided: r.cmp.n_undecided, n_untestable: r.cmp.n_untestable, cstar_ctl: r.cmp.cstar_ctl, underpowered: r.cmp.underpowered, nb_min: r.cmp.nb_min } : null,
      n_grid_anchored: ev.n_grid_anchored, cstar: ev.cstar, tests: ev.tests, counts: ev.counts, counts_grid_strict: ev.counts_grid_strict, rho_res: dv.rho_res, rho_raw: dv.rho_raw, warn: dv.warn,
      top_bins: ev.bins.slice(0, 10), shift_kind: M.DITHER_KIND });
    $('vNums').textContent = 'verdict ' + ev.verdict + ' | N ' + ev.N + ' | detection floor C* ' + ev.cstar.toFixed(4) + ' (Rayleigh, Bonferroni over ' + ev.tests.toLocaleString() + ' tests, alpha ' + ev.alpha + ') | grid-band shift-dead bins ' + ev.n_grid_anchored + ', past the strict grid floor ' + ev.cstar_grid.toFixed(4) + ': ' + ev.n_grid_strict + (r.cmp ? ' | control N ' + r.cmp.Nb + ', floor C*ctl ' + r.cmp.cstar_ctl.toFixed(4) + (r.cmp.underpowered ? ' (too small)' : '') + ', set-only ' + r.cmp.n_set_only + ' off-grid / ' + r.cmp.n_set_only_grid + ' grid, same ' + r.cmp.n_same + ', too faint to tell ' + r.cmp.n_untestable : '') + ' (the grid band is ' + (100 * ev.grid_blind_fraction).toFixed(1) + '% of all bins) | shift-surviving ' + ev.n_shared + ' | content similarity ' + dv.rho_res.toFixed(3) + ' residual / ' + dv.rho_raw.toFixed(3) + ' raw (independent ~' + (dv.independent_expectation || 0).toFixed(3) + ') | ' + secs.toFixed(1) + ' s';
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
    var gt = '<caption style="text-align:left;color:var(--ash);padding:10px 0 6px">On the 8 / 16 px grid, past the stricter floor ' + ev.cstar_grid.toFixed(3) + '</caption><tr><th>channel</th><th>fy, fx (cycles / picture)</th><th>period px</th><th>angle</th><th>agreement C</th></tr>';
    ev.grid_bins.slice(0, 20).forEach(function (q) { gt += '<tr><td>' + q.ch + '</td><td>' + q.fy + ', ' + q.fx + '</td><td>' + q.period_px.toFixed(2) + '</td><td>' + q.angle_deg.toFixed(1) + '\u00b0</td><td>' + q.C.toFixed(3) + '</td></tr>'; });
    $('mGrid').innerHTML = ev.grid_bins.length ? gt : '';
    if (r.cmp) {
      var ct = '<caption style="text-align:left;color:var(--ash);padding:10px 0 6px">Only in this set, not in the ' + r.cmp.Nb + ' control pictures</caption><tr><th>channel</th><th>fy, fx</th><th>period px</th><th>angle</th><th>C set</th><th>C control</th><th>grid?</th></tr>';
      r.cmp.bins.slice(0, 15).map(function (q) { q.g = 'no'; return q; }).concat(r.cmp.grid_bins.slice(0, 10).map(function (q) { q.g = 'yes'; return q; })).forEach(function (q) { ct += '<tr><td>' + q.ch + '</td><td>' + q.fy + ', ' + q.fx + '</td><td>' + q.period_px.toFixed(2) + '</td><td>' + q.angle_deg.toFixed(1) + '\u00b0</td><td>' + q.C.toFixed(3) + '</td><td>' + q.C_control.toFixed(3) + '</td><td>' + q.g + '</td></tr>'; });
      $('mCmp').innerHTML = (r.cmp.bins.length + r.cmp.grid_bins.length) ? ct : '<caption style="text-align:left;color:var(--ash);padding:10px 0 6px">' +
        (r.cmp.underpowered ? 'The ' + r.cmp.Nb + ' control pictures are too few to test against' + (r.cmp.nb_min ? ' (at least ' + r.cmp.nb_min + ' are needed with this set)' : '') + ', so this says nothing either way.' :
          'Against ' + r.cmp.Nb + ' control pictures: no frequency was found only in this set' + (r.cmp.n_untestable ? ' (' + r.cmp.n_untestable + ' were too faint for this control to test)' : '') + (r.cmp.n_undecided ? ' (' + r.cmp.n_undecided + ' were strong enough but undecided: the control does not line up there)' : '') + '.') + '</caption>';
    } else $('mCmp').innerHTML = '';
    var pt = r.pattern;
    [['patMean', pt.mean], ['patRec', pt.rebuilt]].forEach(function (a) { putPack($(a[0]), a[1]); });
    // what this says is what worker.js draws: both pictures shrunk to at most 512 px and at least 2x (area average), one contrast stretch
    // each, grey = zero. No full-resolution copy and no numbers are shown (port, Oct 17 2026)
    var shrunk = pt.shown_w < ev.W ? 'shrunk from ' + ev.W + ' x ' + ev.H + ' to ' + pt.shown_w + ' x ' + pt.shown_h + ' px for the screen, so repeats finer than about ' + (2 * ev.W / pt.shown_w).toFixed(1) + ' px blur away' : 'shown at ' + pt.shown_w + ' x ' + pt.shown_h + ' px';
    $('patNote').textContent = (pt.empty ? 'No frequency was counted, so the rebuilt picture is flat grey; the averaged residual is shown as it is. ' :
      'Rebuilt from ' + pt.n_bins + ' frequency bins' + (pt.from === 'control' ? ' that are only in this set (not in the control)' : ' (anchored off the grid, plus grid ones past the stricter test)') + '. ') +
      'Both pictures are ' + shrunk + ', and each is contrast-stretched on its own scale (grey = zero). They are pictures to look at, not measurements: the page does not export them or their numbers, and nothing is taken out of any picture.';
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
  wireDrop($('drop3'), $('file3'), function (fs) { setCtl(fs); });
  if (!window.HPDecode) status('The page did not load completely (decode.js is missing).', true);
  else if (!window.Worker || !window.createImageBitmap) status('This browser cannot run the finder (it needs Web Workers and createImageBitmap).', true);
})();

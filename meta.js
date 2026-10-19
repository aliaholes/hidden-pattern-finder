/* meta.js -- what the FILE says about itself (born Oct 17 2026). No network: plain JS over bytes already in memory.
 *
 * Reads, without validating any signature:
 *   C2PA / Content Credentials   JPEG APP11 JUMBF segments (reassembled), PNG caBX chunk, WebP C2PA chunk: is a manifest
 *                                store there, its claim_generator, its actions, and any IPTC digitalSourceType inside it.
 *   XMP                          JPEG APP1 "http://ns.adobe.com/xap/1.0/", PNG iTXt XML:com.adobe.xmp, WebP "XMP ":
 *                                Iptc4xmpExt:DigitalSourceType (trainedAlgorithmicMedia & co), CreatorTool, credit.
 *   PNG text                     tEXt / zTXt / iTXt, e.g. Stable Diffusion WebUI "parameters", ComfyUI "prompt"/"workflow".
 *   EXIF                         IFD0 Software (0x0131), Make, Model, Artist, ImageDescription (JPEG APP1, PNG eXIf, WebP EXIF).
 * A signed manifest is only "present" here: checking its signature needs a C2PA validator, which this page doesn't ship.
 * Metadata is trivially stripped or forged; its absence means nothing.
 * Exposes self.HPMeta (and module.exports for node).
 */
(function (root) {
  'use strict';
  function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function latin1(b, s, e) { var out = ''; for (var i = s; i < e; i++) out += String.fromCharCode(b[i]); return out; }
  function utf8(b, s, e) {
    var sub = b.subarray(s, e);
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(sub);
    return decodeURIComponent(escape(latin1(b, s, e)));
  }
  // zlib, local only. CAPPED (port, Oct 17 2026): a tiny compressed text chunk can unpack to gigabytes, and the page shows
  // at most a few hundred characters, so the stream is read only up to INFLATE_MAX bytes (1 MB) and then cancelled, and
  // one file gets at most INFLATE_BUDGET (4 MB) of unpacked text in all. The result carries .cut = true when it stopped early.
  // The budget only holds because readPNG runs the inflates ONE AFTER ANOTHER (fix, Oct 17 2026): started side by side,
  // every chunk read budget.left before any had finished, so 400 small chunks unpacked 400 MB (review-lens5/meta_attack.txt).
  var INFLATE_MAX = 1 << 20, INFLATE_BUDGET = 4 << 20;
  function inflate(bytes, budget) {
    if (typeof DecompressionStream !== 'function') return Promise.resolve(null);
    var limit = Math.min(INFLATE_MAX, budget ? budget.left : INFLATE_MAX);
    if (limit <= 0) { var none = new Uint8Array(0); none.cut = true; return Promise.resolve(none); }
    var rd, parts = [], got = 0;
    function finish(cut) {
      var out = new Uint8Array(got), p = 0;
      for (var i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
      out.cut = cut; if (budget) budget.left -= got;
      return out;
    }
    function pump() {
      return rd.read().then(function (r) {
        if (r.done) return finish(false);
        var take = Math.min(r.value.length, limit - got);
        parts.push(take === r.value.length ? r.value : r.value.slice(0, take)); got += take;
        if (got >= limit) { rd.cancel().catch(function () {}); return finish(true); }
        return pump();
      });
    }
    try { rd = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(); } catch (e) { return Promise.resolve(null); }
    return pump().catch(function () { return got ? finish(true) : null; });
  }
  var SOURCE_TYPES = {
    trainedAlgorithmicMedia: 'made by a trained AI model',
    compositeWithTrainedAlgorithmicMedia: 'a composite that includes AI-generated content',
    algorithmicMedia: 'made by an algorithm (not trained)',
    compositeSynthetic: 'a composite including synthetic elements',
    digitalCapture: 'a digital capture (camera)', digitalArt: 'digital art (human-made)', minorHumanEdits: 'a capture with minor human edits'
  };

  // ------------------------------------------------------------------ EXIF (TIFF) IFD0
  var EXIF_TAGS = { 0x010E: 'ImageDescription', 0x010F: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x013B: 'Artist', 0x8298: 'Copyright' };
  function readTiff(b, t, end) {
    var out = {};
    if (t + 8 > end) return out;
    var le = b[t] === 0x49;
    function r16(p) { return le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]); }
    function r32(p) { return le ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + (b[p + 3] << 24 >>> 0)) : u32(b, p); }
    if (r16(t + 2) !== 42) return out;
    var ifd = t + r32(t + 4);
    if (ifd + 2 > end) return out;
    var n = r16(ifd);
    for (var i = 0; i < n; i++) {
      var e = ifd + 2 + 12 * i;
      if (e + 12 > end) break;
      var tag = r16(e), type = r16(e + 2), cnt = r32(e + 4), name = EXIF_TAGS[tag];
      if (!name || type !== 2) continue;
      var off = cnt <= 4 ? e + 8 : t + r32(e + 8);
      if (off + cnt > end) continue;
      out[name] = utf8(b, off, off + cnt).replace(/\0+$/, '').trim();
    }
    return out;
  }

  // ------------------------------------------------------------------ XMP
  function xmpAttr(x, name) {
    var m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(x) || new RegExp('<' + name + '>\\s*([^<]*?)\\s*</' + name + '>').exec(x);
    return m ? m[1] : null;
  }
  function readXmp(x) {
    var o = { raw_length: x.length };
    var dst = xmpAttr(x, 'Iptc4xmpExt:DigitalSourceType');
    if (dst) o.DigitalSourceType = dst;
    ['xmp:CreatorTool', 'photoshop:Credit', 'dc:creator', 'tiff:Software'].forEach(function (k) { var v = xmpAttr(x, k); if (v) o[k] = v; });
    var hasC2pa = /c2pa|contentauth|stds\.schema-org\.CreativeWork/i.test(x);
    if (hasC2pa) o.mentions_c2pa = true;
    return o;
  }

  // ------------------------------------------------------------------ C2PA (JUMBF, ISO 19566-5 boxes) -- presence + a few strings
  function scanJumbf(b) {
    var o = { bytes: b.length, labels: [], claim_generator: null, actions: [], digital_source_types: [] };
    // superbox labels: 'jumd' box = 16-byte type UUID, toggles byte, then a NUL-terminated label
    for (var i = 4; i + 4 < b.length; i++) {
      if (b[i] === 0x6A && b[i + 1] === 0x75 && b[i + 2] === 0x6D && b[i + 3] === 0x64) { // 'jumd'
        var s = i + 4 + 16 + 1, e = s;
        while (e < b.length && b[e] !== 0 && e - s < 128) e++;
        var lab = latin1(b, s, e);
        if (/^[\x20-\x7e]+$/.test(lab) && o.labels.indexOf(lab) < 0) o.labels.push(lab);
      }
    }
    o.is_c2pa = o.labels.indexOf('c2pa') >= 0 || o.labels.some(function (l) { return /^c2pa\./.test(l); });
    var text = latin1(b, 0, b.length);
    // CBOR: text key "claim_generator" (0x6f + 15 bytes), value a text string (major type 3)
    var k = text.indexOf('claim_generator');
    while (k >= 0) {
      var p = k + 15, mt = b[p], len = -1, st = p + 1;
      if (mt >= 0x60 && mt <= 0x77) len = mt - 0x60; else if (mt === 0x78) { len = b[p + 1]; st = p + 2; } else if (mt === 0x79) { len = u16be(b, p + 1); st = p + 3; }
      if (len > 0 && text[k + 15] !== '_') { o.claim_generator = utf8(b, st, st + len); break; }
      k = text.indexOf('claim_generator', k + 1);
    }
    if (!o.claim_generator) { var ci = text.indexOf('claim_generator_info'); if (ci >= 0) { var nm = /name.([\x20-\x7e]{2,80})/.exec(text.slice(ci, ci + 300)); if (nm) o.claim_generator = nm[1].replace(/[^\x20-\x7e]/g, ''); } }
    var re = /c2pa\.(created|opened|edited|converted|placed|drawing|color_adjustments|resized|cropped|filtered|published|transcoded|repackaged|watermarked)/g, m;
    while ((m = re.exec(text))) if (o.actions.indexOf(m[0]) < 0) o.actions.push(m[0]);
    var re2 = /digitalsourcetype\/([A-Za-z]+)/g;
    while ((m = re2.exec(text))) if (o.digital_source_types.indexOf(m[1]) < 0) o.digital_source_types.push(m[1]);
    return o;
  }

  // ------------------------------------------------------------------ containers
  function readJPEG(b, out) {
    var o = 2, jumbf = {}, order = [];
    while (o + 4 <= b.length) {
      if (b[o] !== 0xFF) { o++; continue; }
      var m = b[o + 1];
      if (m === 0xFF) { o++; continue; }
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { o += 2; continue; }
      if (m === 0xD9 || m === 0xDA) break;
      var len = u16be(b, o + 2), d = o + 4, e = o + 2 + len;
      if (e > b.length) break;
      if (m === 0xE1) {
        if (latin1(b, d, d + 6) === 'Exif\0\0') out.exif = Object.assign(out.exif || {}, readTiff(b, d + 6, e));
        else if (latin1(b, d, d + 29) === 'http://ns.adobe.com/xap/1.0/\0') out.xmp = readXmp(utf8(b, d + 29, e));
      } else if (m === 0xEB && b[d] === 0x4A && b[d + 1] === 0x50) { // APP11 'JP': CI(2) En(2) Z(4) then the box (LBox+TBox repeated in every packet)
        var en = u16be(b, d + 2), z = u32(b, d + 4), body = b.subarray(d + 8, e);
        if (!jumbf[en]) { jumbf[en] = []; order.push(en); }
        jumbf[en].push({ z: z, body: jumbf[en].length ? body.subarray(8) : body });
      } else if (m === 0xFE) { (out.comments = out.comments || []).push(utf8(b, d, e).slice(0, 500)); }
      o = e;
    }
    order.forEach(function (en) {
      var parts = jumbf[en].sort(function (a, c) { return a.z - c.z; }), tot = 0, i;
      for (i = 0; i < parts.length; i++) tot += parts[i].body.length;
      var all = new Uint8Array(tot), p = 0;
      for (i = 0; i < parts.length; i++) { all.set(parts[i].body, p); p += parts[i].body.length; }
      var j = scanJumbf(all);
      if (j.is_c2pa || !out.c2pa) out.c2pa = j;
    });
    return Promise.resolve(out);
  }
  function readPNG(b, out) {
    var o = 8, jobs = [], budget = { left: INFLATE_BUDGET };   // jobs = functions, run in order (see inflate)
    out.text = [];
    while (o + 8 <= b.length) {
      var len = u32(b, o), type = latin1(b, o + 4, o + 8), d = o + 8, e = d + len;
      if (e > b.length) break;
      if (type === 'tEXt') { var z = d; while (z < e && b[z]) z++; out.text.push({ key: latin1(b, d, z), value: latin1(b, z + 1, e) }); }
      else if (type === 'zTXt') {
        (function (d, e) {
          var z = d; while (z < e && b[z]) z++; var key = latin1(b, d, z);
          jobs.push(function () { return inflate(b.subarray(z + 2, e), budget).then(function (u) { out.text.push({ key: key, value: u ? utf8(u, 0, u.length) : '(compressed, could not inflate here)', cut: !!(u && u.cut) }); }); });
        })(d, e);
      } else if (type === 'iTXt') {
        (function (d, e) {
          var z = d; while (z < e && b[z]) z++; var key = latin1(b, d, z), comp = b[z + 1], p = z + 3;
          while (p < e && b[p]) p++; p++; while (p < e && b[p]) p++; p++; // language tag, translated keyword
          var push = function (v, cut) { if (key === 'XML:com.adobe.xmp') out.xmp = readXmp(v); else out.text.push({ key: key, value: v, cut: !!cut }); };
          if (comp) jobs.push(function () { return inflate(b.subarray(p, e), budget).then(function (u) { push(u ? utf8(u, 0, u.length) : '', u && u.cut); }); });
          else push(utf8(b, p, e));
        })(d, e);
      } else if (type === 'eXIf') out.exif = readTiff(b, d, e);
      else if (type === 'caBX') out.c2pa = scanJumbf(b.subarray(d, e));
      else if (type === 'IEND') break;
      o = e + 4;
    }
    return jobs.reduce(function (pr, job) { return pr.then(job); }, Promise.resolve()).then(function () { return out; });
  }
  function readWebP(b, out) {
    var o = 12;
    while (o + 8 <= b.length) {
      // the chunk size is UNSIGNED 32-bit little-endian: '>>> 0' over the whole value (an OR turns it signed again, and a
      // negative size sent this loop backwards or kept it in place forever: port fix, Oct 17 2026)
      var type = latin1(b, o, o + 4), len = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24)) >>> 0, d = o + 8, e = d + len;
      if (e > b.length || e <= o) break;
      if (type === 'EXIF') { var t = latin1(b, d, d + 6) === 'Exif\0\0' ? d + 6 : d; out.exif = readTiff(b, t, e); }
      else if (type === 'XMP ') out.xmp = readXmp(utf8(b, d, e));
      else if (type === 'C2PA') out.c2pa = scanJumbf(b.subarray(d, e));
      var next = e + (len & 1);
      if (next <= o) break; // the walk only ever moves forward
      o = next;
    }
    return Promise.resolve(out);
  }

  // ------------------------------------------------------------------ summary
  // trainedAlgorithmicMedia AND compositeWithTrainedAlgorithmicMedia (capital T): case-insensitive (port fix, Oct 17 2026)
  var TRAINED = /trainedalgorithmic/i;
  var AI_TEXT_KEYS = /^(parameters|prompt|workflow|Dream|sd-metadata|invokeai_metadata|negative_prompt|generation_data)$/i;
  function summarize(out) {
    var flags = [];
    var dst = out.xmp && out.xmp.DigitalSourceType;
    if (dst) { var short = dst.replace(/^.*\//, ''); flags.push({ strong: TRAINED.test(short), what: 'XMP DigitalSourceType = ' + short + (SOURCE_TYPES[short] ? ' (' + SOURCE_TYPES[short] + ')' : '') }); }
    if (out.c2pa && out.c2pa.is_c2pa) {
      var c = out.c2pa;
      flags.push({ strong: false, what: 'C2PA manifest present (' + c.bytes.toLocaleString() + ' bytes, signature NOT checked here)' + (c.claim_generator ? ', made with: ' + c.claim_generator : '') });
      c.digital_source_types.forEach(function (t) { flags.push({ strong: TRAINED.test(t), what: 'C2PA digitalSourceType = ' + t + (SOURCE_TYPES[t] ? ' (' + SOURCE_TYPES[t] + ')' : '') }); });
    }
    (out.text || []).forEach(function (t) { if (AI_TEXT_KEYS.test(t.key)) flags.push({ strong: true, what: 'PNG text "' + t.key + '" (generator settings: ' + t.value.slice(0, 120).replace(/\s+/g, ' ') + (t.value.length > 120 ? '...' : '') + ')' }); });
    if (out.exif && out.exif.Software) flags.push({ strong: false, what: 'EXIF Software = ' + out.exif.Software });
    out.flags = flags;
    out.ai_declared = flags.some(function (f) { return f.strong; });
    return out;
  }
  function read(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), out = { format: 'other' }, p;
    try {
    if (b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) { out.format = 'png'; p = readPNG(b, out); }
    else if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) { out.format = 'jpeg'; p = readJPEG(b, out); }
    else if (b.length > 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP') { out.format = 'webp'; p = readWebP(b, out); }
    else p = Promise.resolve(out);
    } catch (e) { p = Promise.reject(e); }
    return p.then(summarize, function (e) { out.error = String(e && e.message || e); return summarize(out); });
  }
  var api = { read: read, scanJumbf: scanJumbf, readXmp: readXmp, VERSION: 'meta.js 1.1' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HPMeta = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));

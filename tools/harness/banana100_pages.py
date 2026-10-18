#!/usr/bin/env python3
"""Random access into Banana100 (https://huggingface.co/datasets/kenantang/Banana100, CC BY-NC-SA 4.0): Nano Banana
Pro images straight from the Gemini API (28,000 images, 218 GB in one parquet file). The parquet has no page index,
so this walks the output_image column's page headers with HTTP range requests (a few bytes each), maps pages to rows,
and downloads only the pages of the rows asked for.
  python banana100_pages.py index  RG            -> DATA/b100_pages_rgRG.json  (page offsets + row ranges)
  python banana100_pages.py fetch  RG ROW [ROW..] -> DATA/b100/rRow.png (rows are global row numbers)"""
import json, os, sys, urllib.request
import cramjam, pyarrow.parquet as pq, fsspec

URL = 'https://huggingface.co/datasets/kenantang/Banana100/resolve/main/banana100.parquet'
DATA = os.environ.get('HPF_SYNTHID', '/workspace/hpf-data/synthid')

def rng(a, n):
    for k in range(5):
        try:
            req = urllib.request.Request(URL, headers={'Range': 'bytes=%d-%d' % (a, a + n - 1), 'User-Agent': 'hpf-harness'})
            with urllib.request.urlopen(req, timeout=120) as r: return r.read()
        except Exception:
            if k == 4: raise

# --- minimal Thrift compact protocol reader (enough for PageHeader)
class R:
    def __init__(s, b): s.b, s.p = b, 0
    def byte(s): v = s.b[s.p]; s.p += 1; return v
    def varint(s):
        sh = v = 0
        while True:
            x = s.byte(); v |= (x & 0x7f) << sh; sh += 7
            if not x & 0x80: return v
    def zz(s): v = s.varint(); return (v >> 1) ^ -(v & 1)
    def skip(s, t):
        if t in (1, 2): return
        if t == 3: s.p += 1; return
        if t in (4, 5, 6): s.varint(); return
        if t == 7: s.p += 8; return
        if t == 8: n = s.varint(); s.p += n; return
        if t in (9, 10):
            h = s.byte(); n = h >> 4; et = h & 15
            if n == 15: n = s.varint()
            for _ in range(n): s.skip(et)
            return
        if t == 12: s.struct(); return
        raise ValueError('thrift type %d' % t)
    def struct(s, want=None):
        out, last = {}, 0
        while True:
            h = s.byte()
            if h == 0: return out
            d, t = h >> 4, h & 15
            fid = last + d if d else s.zz(); last = fid
            if want and fid in want and t == 12: out[fid] = s.struct(want[fid])
            elif t in (5, 6): out[fid] = s.zz()
            elif t in (1, 2): out[fid] = (t == 1)
            else: s.skip(t)

HDR = {5: {}, 7: {}, 8: {}}   # data_page_header, dictionary_page_header, data_page_header_v2

def page_header(off):
    b = rng(off, 256); r = R(b); h = r.struct(HDR); return h, r.p

def index(rg):
    f = fsspec.open(URL, 'rb', block_size=2 ** 20).open(); md = pq.ParquetFile(f).metadata
    c = md.row_group(rg).column(5); first_row = sum(md.row_group(i).num_rows for i in range(rg))
    off = c.dictionary_page_offset if c.has_dictionary_page else c.data_page_offset
    end = off + c.total_compressed_size; pages = []; row = first_row
    while off < end:
        h, hl = page_header(off)
        typ, csize = h[1], h[3]
        if typ == 2: pages.append({'off': off, 'hl': hl, 'csize': csize, 'type': 'dict', 'n': h[7][1]})
        else:
            n = (h.get(5) or h.get(8))[1]
            pages.append({'off': off, 'hl': hl, 'csize': csize, 'type': 'data' if typ == 0 else 'data2', 'enc': (h.get(5) or h.get(8)).get(2), 'n': n, 'row0': row}); row += n
        off += hl + csize
        if len(pages) % 50 == 0: print('\rpages %d rows %d' % (len(pages), row - first_row), end='', file=sys.stderr)
    json.dump({'rg': rg, 'first_row': first_row, 'pages': pages}, open(os.path.join(DATA, 'b100_pages_rg%d.json' % rg), 'w'))
    print('\nrg %d: %d pages' % (rg, len(pages)), file=sys.stderr)

def plain_values(buf, n):
    out, p = [], 0
    for _ in range(n):
        L = int.from_bytes(buf[p:p + 4], 'little'); out.append(bytes(buf[p + 4:p + 4 + L])); p += 4 + L
    return out

def fetch(rg, rows):
    J = json.load(open(os.path.join(DATA, 'b100_pages_rg%d.json' % rg))); os.makedirs(os.path.join(DATA, 'b100'), exist_ok=True)
    for row in rows:
        pg = [p for p in J['pages'] if p['type'] != 'dict' and p['row0'] <= row < p['row0'] + p['n']]
        if not pg: print('row %d not in a data page (in the dictionary page?)' % row, file=sys.stderr); continue
        p = pg[0]
        if p['enc'] not in (0,): print('row %d: page encoding %s not PLAIN, skipped' % (row, p['enc']), file=sys.stderr); continue
        raw = rng(p['off'] + p['hl'], p['csize'])
        u = bytes(cramjam.snappy.decompress_raw(raw))
        if p['type'] == 'data':  # v1: [4-byte len][RLE def levels] then values
            dl = int.from_bytes(u[:4], 'little'); u = u[4 + dl:]
        vals = plain_values(u, p['n'])
        v = vals[row - p['row0']]
        ext = 'png' if v[:4] == b'\x89PNG' else ('jpg' if v[:2] == b'\xff\xd8' else 'bin')
        open(os.path.join(DATA, 'b100', 'r%05d.%s' % (row, ext)), 'wb').write(v)
        print('row %d -> %d bytes %s' % (row, len(v), ext), file=sys.stderr)

def fetch_page_rows(rg, page_row0, keep):
    """Stream one whole data page (about 2 GB, ~300 consecutive rows) to a temp file, snappy-decompress it, and save
    only rows for which keep(global_row) is true as DATA/b100/rROW.png. The temp file is deleted afterwards."""
    import subprocess, mmap
    J = json.load(open(os.path.join(DATA, 'b100_pages_rg%d.json' % rg)))
    p = [q for q in J['pages'] if q['type'] != 'dict' and q['row0'] == page_row0][0]
    tmp = os.path.join(DATA, 'page.tmp'); a = p['off'] + p['hl']
    subprocess.run(['curl', '-sfL', '--retry', '5', '-r', '%d-%d' % (a, a + p['csize'] - 1), '-o', tmp, URL], check=True)
    with open(tmp, 'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        u = cramjam.snappy.decompress_raw(mm); mm.close()
    os.remove(tmp)
    u = memoryview(u)
    if p['type'] == 'data': dl = int.from_bytes(u[:4], 'little'); u = u[4 + dl:]
    os.makedirs(os.path.join(DATA, 'b100'), exist_ok=True); pos = 0; saved = 0
    for k in range(p['n']):
        L = int.from_bytes(u[pos:pos + 4], 'little'); row = p['row0'] + k
        if keep(row):
            v = bytes(u[pos + 4:pos + 4 + L]); ext = 'png' if v[:4] == b'\x89PNG' else ('jpg' if v[:2] == b'\xff\xd8' else 'bin')
            open(os.path.join(DATA, 'b100', 'r%05d.%s' % (row, ext)), 'wb').write(v); saved += 1
        pos += 4 + L
    del u
    return saved

if __name__ == '__main__':
    if sys.argv[1] == 'index': index(int(sys.argv[2]))
    else: fetch(int(sys.argv[2]), [int(x) for x in sys.argv[3:]])

#!/usr/bin/env python3
"""Control photos from Wikimedia Commons: camera JPEGs uploaded before 2020 whose EXIF DateTimeOriginal is before
2020 and that name a camera Make. Pulled from Category:Quality images (via the MediaWiki API, imageinfo with
extmetadata/commonmetadata), originals downloaded, provenance (title, URL, uploader timestamp, DateTimeOriginal,
Make/Model, licence, sha256) written to DATA/commons_manifest.json.
usage: python fetch_commons.py [--n 150] [--minw 3000] [--minh 3000] [--data /workspace/hpf-data/synthid]"""
import argparse, hashlib, json, os, time, urllib.parse, urllib.request
API = 'https://commons.wikimedia.org/w/api.php'
UA = {'User-Agent': 'hpf-harness/0.1 (research; hidden-pattern-finder control set)'}

def get(url, tries=5):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r: return r.read()
        except Exception:
            if k == tries - 1: raise
            time.sleep(3 + 3 * k)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--n', type=int, default=150); ap.add_argument('--minw', type=int, default=3000); ap.add_argument('--minh', type=int, default=3000)
    ap.add_argument('--data', default='/workspace/hpf-data/synthid'); ap.add_argument('--cat', default='Category:Quality images'); a = ap.parse_args()
    out = os.path.join(a.data, 'commons'); os.makedirs(out, exist_ok=True); man = []; cont = {}
    while len(man) < a.n:
        q = {'action': 'query', 'format': 'json', 'generator': 'categorymembers', 'gcmtitle': a.cat, 'gcmtype': 'file', 'gcmlimit': '50', 'gcmsort': 'timestamp', 'gcmdir': 'asc',
             'prop': 'imageinfo', 'iiprop': 'url|size|timestamp|mime|commonmetadata|extmetadata|sha1'}
        q.update(cont); d = json.loads(get(API + '?' + urllib.parse.urlencode(q)))
        for p in d.get('query', {}).get('pages', {}).values():
            ii = (p.get('imageinfo') or [{}])[0]
            if ii.get('mime') != 'image/jpeg' or ii.get('width', 0) < a.minw or ii.get('height', 0) < a.minh: continue
            if ii.get('timestamp', '9') >= '2020': continue
            cm = {m['name']: m['value'] for m in ii.get('commonmetadata', []) if isinstance(m.get('value'), (str, int, float))}
            dto = str(cm.get('DateTimeOriginal', '')); make = str(cm.get('Make', '')).strip()
            if not dto or dto[:4] >= '2020' or not dto[:4].isdigit() or not make: continue
            if any(s in str(cm.get('Software', '')).lower() for s in ['photoshop', 'gimp', 'hugin', 'ptgui', 'lightroom', 'stitch']): continue  # skip heavily processed / stitched
            fn = os.path.join(out, 'c%08d.jpg' % int(p['pageid']))
            if not os.path.exists(fn): open(fn, 'wb').write(get(ii['url']))
            em = ii.get('extmetadata', {})
            man.append({'file': os.path.basename(fn), 'title': p['title'], 'url': ii['url'], 'uploaded': ii['timestamp'], 'DateTimeOriginal': dto, 'Make': make, 'Model': str(cm.get('Model', '')),
                        'Software': str(cm.get('Software', '')), 'W': ii['width'], 'H': ii['height'], 'license': em.get('LicenseShortName', {}).get('value'), 'sha256': hashlib.sha256(open(fn, 'rb').read()).hexdigest()})
            print('\r%d' % len(man), end='', flush=True)
            if len(man) >= a.n: break
        if 'continue' not in d: break
        cont = d['continue']
    json.dump(man, open(os.path.join(a.data, 'commons_manifest.json'), 'w'), indent=1); print('\nsaved', len(man))

if __name__ == '__main__': main()

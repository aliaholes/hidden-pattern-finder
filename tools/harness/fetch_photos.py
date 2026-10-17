#!/usr/bin/env python3
"""Download the harness's real photos from Lorem Picsum (https://picsum.photos), which serves Unsplash photos under the
Unsplash License (free to use, https://unsplash.com/license). Each photo is fetched as a 512 x 512 centre crop and
saved as received (Picsum serves JPEG). A manifest (id, author, Unsplash URL, sha256) is written next to them so a run
can be checked against the same pixels. Nothing here is committed to git: the photos live in --out (default
../../../hpf-data/photos, outside the repo).
usage: python fetch_photos.py [--n 160] [--size 512] [--out DIR]"""
import argparse, hashlib, json, os, sys, time, urllib.request

def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'hpf-harness'}), timeout=30) as r:
                return r.read()
        except Exception as e:
            if k == tries - 1: raise
            time.sleep(1 + 2 * k)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=160)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'hpf-data', 'photos'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    items, page = [], 1
    while len(items) < a.n:
        items += json.loads(get('https://picsum.photos/v2/list?page=%d&limit=100' % page)); page += 1
    items = items[:a.n]
    man = []
    for k, it in enumerate(items):
        fn = os.path.join(a.out, 'p%04d.jpg' % int(it['id']))
        if not os.path.exists(fn):
            open(fn, 'wb').write(get('https://picsum.photos/id/%s/%d/%d' % (it['id'], a.size, a.size)))
        man.append({'file': os.path.basename(fn), 'id': it['id'], 'author': it['author'], 'url': it['url'], 'sha256': hashlib.sha256(open(fn, 'rb').read()).hexdigest()})
        print('\r%d / %d' % (k + 1, len(items)), end='', file=sys.stderr)
    json.dump(man, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1)
    print('\nwrote %d photos + manifest.json to %s' % (len(man), os.path.abspath(a.out)), file=sys.stderr)

if __name__ == '__main__':
    main()

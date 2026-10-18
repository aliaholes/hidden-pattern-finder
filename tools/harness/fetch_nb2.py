#!/usr/bin/env python3
"""Fetch the Nano Banana 2 (Gemini image) examples linked from https://github.com/ZizheRuan/awesome-nanobanana2.
The repo itself only hosts small thumbnails (<= 680 px, re-encoded), so the full images are taken from the X posts it
links. The post -> media list comes from an X API v2 posts lookup (expansions=attachments.media_keys,
media.fields=url,width,height) saved as DATA/x_posts.json; this script then downloads each media URL with
?name=orig (the largest X serves), and writes a provenance manifest: post URL, media URL, sha256, size, format,
estimated JPEG quality, and the repo's own role tag for the post's images (README "input"/"output" order is not
machine-readable, so 'role' is a heuristic: see manifest notes).
usage: python fetch_nb2.py [--data /workspace/hpf-data/synthid]"""
import argparse, hashlib, io, json, os, time, urllib.request
from PIL import Image

def get(url):
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'hpf-harness'}), timeout=60) as r: return r.read()
        except Exception:
            if k == 3: raise
            time.sleep(2 + 2 * k)

def jpeg_quality(im):
    """IJG-style estimate from the luma quantization table (None if not JPEG)."""
    q = getattr(im, 'quantization', None)
    if not q: return None
    t = q[0]; std = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99]
    s = sum(t) / sum(std) * 100
    return round(200 - s) / 2 if s <= 100 else round(5000 / s)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='/workspace/hpf-data/synthid'); a = ap.parse_args()
    d = json.load(open(os.path.join(a.data, 'x_posts.json')))
    owner = {}
    for p in d['data']:
        for k in p.get('attachments', {}).get('media_keys', []): owner[k] = p
    out = os.path.join(a.data, 'raw'); os.makedirs(out, exist_ok=True); man = []
    for m in d['includes']['media']:
        if m.get('type') != 'photo': continue
        url = m['url']; base, ext = url.rsplit('.', 1)
        b = get(base + '?format=' + ext + '&name=orig')
        fn = os.path.join(out, m['media_key'] + '.' + ext); open(fn, 'wb').write(b)
        im = Image.open(io.BytesIO(b)); p = owner.get(m['media_key'], {})
        man.append({'file': os.path.basename(fn), 'post': 'https://x.com/i/status/' + p.get('id', ''), 'post_created': p.get('created_at'), 'post_text': p.get('text', '')[:200],
                    'media_url': url, 'sha256': hashlib.sha256(b).hexdigest(), 'W': im.size[0], 'H': im.size[1], 'format': im.format,
                    'jpeg_quality_est': jpeg_quality(im), 'bytes': len(b)})
    json.dump(man, open(os.path.join(a.data, 'nb2_manifest.json'), 'w'), indent=1)
    print('downloaded', len(man))

if __name__ == '__main__': main()

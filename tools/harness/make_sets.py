#!/usr/bin/env python3
"""Build the harness's image sets from the downloaded photos (fetch_photos.py) and verify every embedded mark with its
own decoder. Every set is written as PNG (pixels exactly as PIL reads them; JPEG sets are compressed, then decoded by
PIL and stored as PNG, so node reads the same pixels the Python decoders saw).

Photos are split into --subsets disjoint groups of --per photos (default 4 x 40 = 160). For each group:
  clean          the photo as decoded (Picsum JPEG -> RGB)
  clean_jpeg75   clean, re-saved as JPEG quality 75
  clean_resized  clean, bicubic down to 80 % and back up to 512 (interpolation peaks)
  dwtdct_sd1     invisible-watermark dwtDct, payload "StableDiffusionV1" (136 bits, SD 1.x scripts)
  dwtdct_sdxl    invisible-watermark dwtDct, 48-bit 0xB3EC907BB19E (Stability sgm / SDXL)
  dwtdct_sd1_jpeg90  dwtdct_sd1 re-saved as JPEG quality 90
  dwtdctsvd_sd1  invisible-watermark dwtDctSvd, "StableDiffusionV1"
  rivagan        invisible-watermark rivaGan (32 bits) -- only if onnxruntime is installed
  trustmark      Adobe TrustMark (variant Q, fixed bit string) -- only if the trustmark package is installed
  fixed_pattern  a FIXED additive pattern (40 random-phase carriers, each +-0.5 grey level, sum RMS about 2.2) -- a SynthID-like
                 content-agnostic positive control whose every bin is known
Writes DATA/sets/<group>/<set>/NNN.png and DATA/sets/decoders.json (per-set decoder bit accuracy).
usage: python make_sets.py [--data ../../../hpf-data] [--subsets 4] [--per 40]"""
import argparse, io, json, os, sys
import numpy as np
from PIL import Image
import cv2
from imwatermark import WatermarkEncoder, WatermarkDecoder

SD1 = 'StableDiffusionV1'.encode('utf-8')
SDXL_BITS = [int(b) for b in bin(0b101100111110110010010000011110111011000110011110)[2:]]
RIVA_BITS = [int(b) for b in bin(0xC0FFEE42)[2:].zfill(32)]

def jpeg(rgb, q):
    buf = io.BytesIO(); Image.fromarray(rgb).save(buf, 'JPEG', quality=q); buf.seek(0)
    return np.array(Image.open(buf).convert('RGB'))

def bits_of_bytes(b): return list(np.unpackbits(np.frombuffer(b, dtype=np.uint8)))

def enc(rgb, method, kind, payload):
    e = WatermarkEncoder(); e.set_watermark(kind, payload)
    if method == 'rivaGan': WatermarkEncoder.loadModel()
    return cv2.cvtColor(e.encode(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), method), cv2.COLOR_BGR2RGB)

def dec_acc(rgb, method, kind, truth):
    L = len(truth)
    d = WatermarkDecoder('bits', L)
    if method == 'rivaGan': WatermarkDecoder.loadModel()
    got = d.decode(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), method)
    got = [int(x) for x in got]
    return float(np.mean(np.array(got) == np.array(truth))), got

def fixed_pattern(H, W, seed=4242, n=40, amp=0.5):
    r = np.random.default_rng(seed); P = np.zeros((H, W))
    yy, xx = np.mgrid[0:H, 0:W]
    for _ in range(n):
        fy, fx = r.integers(-40, 41), r.integers(3, 60)
        P += amp * np.cos(2 * np.pi * (fy * yy / H + fx * xx / W) + r.uniform(0, 2 * np.pi))
    return P   # each carrier +-amp grey levels; the sum's RMS is about amp * sqrt(n / 2)

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--data', default=os.path.join(here, '..', '..', '..', 'hpf-data'))
    ap.add_argument('--only', default=None, help='rebuild just this one set (e.g. fixed_pattern)')
    ap.add_argument('--subsets', type=int, default=4); ap.add_argument('--per', type=int, default=40)
    a = ap.parse_args()
    man = json.load(open(os.path.join(a.data, 'photos', 'manifest.json')))
    need = a.subsets * a.per
    if len(man) < need: sys.exit('need %d photos, have %d (run fetch_photos.py --n %d)' % (need, len(man), need))
    try:
        import onnxruntime  # noqa
        have_riva = True
    except Exception: have_riva = False
    try:
        from trustmark import TrustMark
        tm = TrustMark(verbose=False, model_type='Q'); TM_BITS = '1011001110110010010000011110111011000110011110101101001110110010010000011110111011000110011110'[:61]
    except Exception as e:
        tm = None; print('TrustMark not available:', e, file=sys.stderr)
    out = os.path.join(a.data, 'sets'); report = {'have_rivagan': have_riva, 'have_trustmark': tm is not None, 'sets': {}}
    P = None
    for g in range(a.subsets):
        for k in range(a.per):
            m = man[g * a.per + k]
            rgb = np.array(Image.open(os.path.join(a.data, 'photos', m['file'])).convert('RGB'))
            H, W = rgb.shape[:2]
            if P is None: P = fixed_pattern(H, W)
            if a.only == 'fixed_pattern':
                d = os.path.join(out, 'g%d' % g, 'fixed_pattern'); os.makedirs(d, exist_ok=True)
                Image.fromarray(np.clip(np.round(rgb.astype(float) + P[:, :, None]), 0, 255).astype(np.uint8)).save(os.path.join(d, '%03d.png' % k))
                continue
            sets = {'clean': rgb, 'clean_jpeg75': jpeg(rgb, 75),
                    'clean_resized': np.array(Image.fromarray(rgb).resize((int(W * .8), int(H * .8)), Image.BICUBIC).resize((W, H), Image.BICUBIC))}
            checks = {}
            x = enc(rgb, 'dwtDct', 'bytes', SD1); sets['dwtdct_sd1'] = x; checks['dwtdct_sd1'] = dec_acc(x, 'dwtDct', 'bits', bits_of_bytes(SD1))
            x = enc(rgb, 'dwtDct', 'bits', SDXL_BITS); sets['dwtdct_sdxl'] = x; checks['dwtdct_sdxl'] = dec_acc(x, 'dwtDct', 'bits', SDXL_BITS)
            xj = jpeg(sets['dwtdct_sd1'], 90); sets['dwtdct_sd1_jpeg90'] = xj; checks['dwtdct_sd1_jpeg90'] = dec_acc(xj, 'dwtDct', 'bits', bits_of_bytes(SD1))
            x = enc(rgb, 'dwtDctSvd', 'bytes', SD1); sets['dwtdctsvd_sd1'] = x; checks['dwtdctsvd_sd1'] = dec_acc(x, 'dwtDctSvd', 'bits', bits_of_bytes(SD1))
            checks['clean'] = dec_acc(rgb, 'dwtDct', 'bits', bits_of_bytes(SD1))   # chance level reference
            if have_riva:
                x = enc(rgb, 'rivaGan', 'bits', RIVA_BITS); sets['rivagan'] = x; checks['rivagan'] = dec_acc(x, 'rivaGan', 'bits', RIVA_BITS)
            if tm is not None:
                im = tm.encode(Image.fromarray(rgb), TM_BITS, MODE='binary'); x = np.array(im.convert('RGB'))
                wm, present, _ = tm.decode(Image.fromarray(x), MODE='binary')
                sets['trustmark'] = x; checks['trustmark'] = (float(np.mean([a_ == b_ for a_, b_ in zip(wm, TM_BITS)])) if present else 0.0, None)
            sets['fixed_pattern'] = np.clip(np.round(rgb.astype(float) + P[:, :, None]), 0, 255).astype(np.uint8)
            for s, img in sets.items():
                d = os.path.join(out, 'g%d' % g, s); os.makedirs(d, exist_ok=True)
                Image.fromarray(img).save(os.path.join(d, '%03d.png' % k))
                if s in checks:
                    r = report['sets'].setdefault(s, {'acc': [], 'perfect': 0, 'n': 0, 'bits': {}})
                    acc, got = checks[s]; r['acc'].append(acc); r['n'] += 1; r['perfect'] += acc == 1.0
                    if got is not None: r['bits']['g%d/%03d' % (g, k)] = ''.join(map(str, got))
            print('\rgroup %d photo %d' % (g, k), end='', file=sys.stderr)
    if a.only: print('\nrebuilt', a.only, file=sys.stderr); return
    for s, r in report['sets'].items():
        r['mean_bit_accuracy'] = float(np.mean(r['acc'])); r['min_bit_accuracy'] = float(np.min(r['acc'])); del r['acc']
    json.dump(report, open(os.path.join(out, 'decoders.json'), 'w'), indent=1)
    print('\n' + json.dumps({s: {k: v for k, v in r.items() if k != 'bits'} for s, r in report['sets'].items()}, indent=1), file=sys.stderr)

if __name__ == '__main__':
    main()

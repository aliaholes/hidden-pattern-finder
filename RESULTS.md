# Harness results

Produced by `tools/harness/run_detect.js` on 2026-10-17 (298 s, node v20.19.2, meter.js 1.2 (port of hidden-pattern-scan v1.2 + model-mark-scan v1.1; numpy PCG64 draws), wmdecode.js 1.0 (invisible-watermark 0.2.0 dwtDct decoder port)).
Photos: 160 Unsplash-licensed photos from Lorem Picsum, 512 x 512 (`tools/harness/fetch_photos.py`, manifest with sha256 in the data dir), split into 4 disjoint groups of 40. Each row below is 4 sets of N = 40 images.

## 1. Embedding check (each mark's OWN decoder, Python)

| set | images | mean bit accuracy | min | decoded perfectly |
|---|---|---|---|---|
| clean (dwtDct decoder on unmarked: chance level) | 160 | 0.498 | 0.434 | 0 |
| dwtdct_sd1 | 160 | 0.829 | 0.500 | 62 |
| dwtdct_sdxl | 160 | 0.862 | 0.438 | 83 |
| dwtdct_sd1_jpeg90 | 160 | 0.525 | 0.412 | 0 |
| dwtdctsvd_sd1 | 160 | 1.000 | 1.000 | 160 |
| rivagan | 160 | 0.998 | 0.719 | 158 |
| trustmark | 160 | 0.994 | 0.000 | 159 |

## 2. Many images (phase coherence, alpha 0.01 Bonferroni) and Set vs control

"anchored" = sets with at least one anchored OFF-grid bin (the page's red verdict). "grid-anchored" = sets with a grid bin past the stricter floor (p x 1/100). "vs control" = sets with at least one SET-ONLY bin against the clean set of the next group (two-sample test); bins listed as off-grid/grid per set.

| set | kind | anchored (of 4) | anchored bins per set | grid-anchored (of 4) | grid bins per set | vs control: alarms (of 4) | set-only bins off/grid |
|---|---|---|---|---|---|---|---|
| clean | clean: clean photos (Picsum JPEG, decoded) | 0 | 0, 0, 0, 0 | 4 | 1, 1, 1, 2 | 0 | 0/0, 0/0, 0/0, 0/0 |
| clean_jpeg75 | clean: clean, re-saved JPEG q75 | 0 | 0, 0, 0, 0 | 4 | 2, 1, 1, 2 | 0 | 0/0, 0/0, 0/0, 0/0 |
| clean_resized | clean: clean, bicubic 80 % down + back up | 0 | 0, 0, 0, 0 | 4 | 2, 2, 2, 2 | 0 | 0/0, 0/0, 0/0, 0/0 |
| dwtdct_sd1 | marked: invisible-watermark dwtDct, "StableDiffusionV1" | 4 | 2050, 2713, 2181, 1781 | 4 | 302, 307, 300, 276 | 4 | 192/27, 313/27, 291/41, 207/32 |
| dwtdct_sd1_jpeg90 | marked: dwtDct "StableDiffusionV1", then JPEG q90 | 4 | 52, 67, 62, 37 | 4 | 11, 5, 5, 5 | 3 | 0/0, 2/0, 1/0, 1/0 |
| dwtdct_sdxl | marked: invisible-watermark dwtDct, SDXL 48-bit | 4 | 1356, 1991, 1537, 1341 | 4 | 405, 403, 425, 364 | 4 | 176/23, 241/42, 246/58, 177/35 |
| dwtdctsvd_sd1 | marked: invisible-watermark dwtDctSvd, "StableDiffusionV1" | 4 | 4130, 5486, 4798, 4225 | 4 | 229, 302, 260, 226 | 4 | 728/24, 987/31, 1100/27, 869/23 |
| fixed_pattern | marked: fixed additive pattern, 40 carriers of +-0.5 level each (synthetic, SynthID-like) | 4 | 32, 33, 33, 34 | 4 | 7, 7, 7, 8 | 4 | 15/2, 16/2, 20/1, 19/1 |
| rivagan | marked: invisible-watermark rivaGan (32 bits) | 0 | 0, 0, 0, 0 | 4 | 1, 1, 1, 1 | 0 | 0/0, 0/0, 0/0, 0/0 |
| trustmark | marked: Adobe TrustMark Q (61 bits) | 0 | 0, 0, 0, 0 | 4 | 1, 1, 2, 1 | 0 | 0/0, 0/0, 0/0, 0/0 |

**Summary.** False alarms on the 12 clean sets (clean, JPEG q75, resized): off-grid anchored 0 / 12, grid-anchored 12 / 12, vs control 0 / 12. Hits on marked sets (off-grid anchored / vs control): dwtdct_sd1 4/4 of 4, dwtdct_sd1_jpeg90 4/3 of 4, dwtdct_sdxl 4/4 of 4, dwtdctsvd_sd1 4/4 of 4, fixed_pattern 4/4 of 4, rivagan 0/0 of 4, trustmark 0/0 of 4.

## 3. In-browser DWT-DCT reader (wmdecode.js), per image

"MATCH" = a known payload (SD "StableDiffusionV1" 136 bits or SDXL 48 bits) matched with binomial p < 1e-6. "agrees with Python" = bits identical to imwatermark's decoder on the same pixels.

| set | images | MATCH | agrees with Python (bits) | images bit-identical |
|---|---|---|---|---|
| clean | 160 | 0 (0.0 %) | 100.000 % | 160 / 160 |
| clean_jpeg75 | 160 | 0 (0.0 %) | n/a | n/a |
| clean_resized | 160 | 0 (0.0 %) | n/a | n/a |
| dwtdct_sd1 | 160 | 113 (70.6 %) | 100.000 % | 160 / 160 |
| dwtdct_sd1_jpeg90 | 160 | 0 (0.0 %) | 100.000 % | 160 / 160 |
| dwtdct_sdxl | 160 | 106 (66.3 %) | 100.000 % | 160 / 160 |
| dwtdctsvd_sd1 | 160 | 1 (0.6 %) | n/a | n/a |
| fixed_pattern | 160 | 0 (0.0 %) | n/a | n/a |
| rivagan | 160 | 0 (0.0 %) | n/a | n/a |
| trustmark | 160 | 0 (0.0 %) | n/a | n/a |

## SynthID / Nano Banana investigation (Oct 2026)

**Data.** (1) 59 Nano Banana 2 images from posts linked in awesome-nanobanana2, downloaded at `?name=orig` from X. All are re-encoded (JPEG q≈85, plus 2 PNGs). The largest same-size group has 8 images, and at most 4 of those are confirmed outputs. That is below the ~20 images the phase-coherence test needs, so the test cannot run meaningfully. (2) Banana100 (arXiv 2604.03400, HF `kenantang/Banana100`): Nano Banana **Pro** API PNGs from iterative "replica" edit chains. 10 seeds and 13 complete runs (step 1 and step 100) were analysed, all on a common 1504×1504 centre crop. (3) Wikimedia Commons camera photos from before 2020 (41 so far) as controls.

**Metadata.** No C2PA, IPTC or SynthID markers on any raw download (X, repo thumbnails, Banana100 PNGs). Every distribution channel had stripped them.

**Edit-chain spectra (D = step100 − step1, green channel, whitened).**
- The one feature that recurs is horizontal banding with a period of 32 px. It is the top peak in 5 of 10 seeds.
- Every other peak is seed-specific (texture, periods of 2–6 px).
- Split-half replication over seeds (top 50 bins): mean overlap 0.68 vs 0.002 expected by chance. That is weak, and it comes only from the 32 px line.
- A 32 px period lines up with a 16/32-px processing grid. It is consistent with a block/tiling artifact and does not show a watermark carrier.
- The diagonal ~40 px pattern reported on Reddit (r/nanobanana, u/thrftshxp, after oversaturation) shows **no excess power** here: whitened power in that region is at or below the median.
- Visual: `shots/synthid-chain-spectrum.png` (not committed).

**Conclusion.** With this data the finder does **not** detect SynthID. The NB2 groups are too small to test. The Banana100 chains show a weak grid-aligned 32 px artifact, nothing that matches published reverse-SynthID carrier claims, and no diagonal pattern. Confidence that the tool *cannot* detect SynthID is low: no group had 30+ native, unmodified images at one size.

## reverse-SynthID: an independent check of its detection claims (Oct 2026)

Method and data credit: **reverse-SynthID by Alosh Denny, github.com/aloshdenny/reverse-SynthID**. We studied only its
detection side. None of its removal or bypass code was used, and its carrier tables are not reproduced here.

**What it claims (README, commit b110836).**
- SynthID carriers sit at resolution-dependent bins with a fixed phase, and the green channel is strongest.
- At 1024², the claim comes from 100 black + 100 white references. Its top carriers are low-frequency diagonals; we
  give only coarse bands here: 32 px to >100 px, at about 25–45°.
- At 1536 × 2816, the claim comes from 88 content images. Its top "carrier" is on the Nyquist row at a quarter of the
  width: < 3 px at about 60°.
- It reports a detector with "90 % accuracy". The code (`robust_extractor.detect_array`) resizes to 512, takes the
  grayscale FFT phase at the listed carriers and compares it with stored reference phases. Its docstring says it was
  calibrated on 291 watermarked vs **16** non-watermarked images, a very small negative set.

**Data.** The project's public Hugging Face dataset `aoxo/reverse-synthid`: 997 files downloaded for local research
only, not redistributed, no licence stated on the card. All PNGs; no C2PA or other provenance metadata. Same-size
groups:
- legacy black and white sets: 100 + 100 at 1024², and `gemini_random` 88 at 2816 × 1536
- `nano-banana-pro-preview` and `gemini-3.1-flash-image-preview`: about 10 images per solid colour at 1024²
  (pooled: 48 and 59), plus 99 and 98 "diverse" content images at 1408 × 768

Controls:
- 100 synthetic blank PNGs (flat level + Gaussian noise, same PNG encoder)
- DALL·E 3 solids (60) and DALL·E 3 content crops (33), from the same dataset and in the same PNG format
- Wikimedia Commons camera crops at each size (120)

**Many-images test** (numpy port `tools/harness/coh_np.py`; it reproduces this file's counts on the harness sets
exactly). Off-grid anchored / grid-strict bins; split-half = top-200-bin overlap between random halves of 10 image
groups, 20 splits, vs chance K²/M.

| Set | N | Off-grid | Grid | vs control (off/grid) | Split-half (chance ≈ 0.02–0.08) |
|---|---|---|---|---|---|
| NB Pro diverse 1408×768 | 99 | 19 | 202 | Commons 14/57, DALL·E 4/9 | 5.95 (p ≈ 3e-10) |
| Gemini 3.1 diverse 1408×768 | 98 | 16 | 101 | Commons 11/34, DALL·E 3/14 | 5.05 (p ≈ 3e-8) |
| gemini_random 2816×1536 | 88 | 17 | 293 | Commons 13/133 | 6.05 (p ≈ 6e-14) |
| legacy white 1024² | 100 | 419 | 1885 | synthetic 32/770 | 72 |
| legacy black 1024² | 100 | 364,640 | 35,930 | synthetic 313,375/28,314 | 53 (near-duplicates, see below) |
| NB Pro solids 1024² (6 colours) | 48 | 0 | 55 | synthetic 0/9 | 0.05 (chance) |
| Gemini 3.1 solids 1024² | 59 | 5 | 57 | synthetic 0/4 | 1.6 (chance level) |
| Controls: Commons, DALL·E, synthetic | 33–120 | **0** | 0–14 | 0/0–7 | 0–0.1 |

Cross-set overlap of top bins (same size):
- NB Pro vs Gemini 3.1 diverse: 8 / 200 (chance 0.08, p ≈ 3e-14). NB Pro vs DALL·E: 0.
- Legacy black vs white: 34 / 200 (p ≈ 2e-78). This survives restricting black to its non-palette RGBA files
  (18 / 200, p ≈ 1e-36).

**Where.** Coarse locations only:
- On the content sets, the off-grid bins are mostly 3–6 px at about 90° (horizontal stripes). The grid bins sit
  mostly on the Nyquist row (< 3 px at about 90°).
- On `gemini_random`, the bin at the Nyquist row × quarter-width is perfectly phase-locked (C = 1.00 over 88 images;
  0.10 in the Commons control). It is the same coarse location as reverse-SynthID's 1536 × 2816 top carrier.
- On the legacy white set, 2 of the 8 listed 1024² low-frequency positions (± sign) pass our threshold.
- On the new-model solids, none pass.

**Caveats.**
- (1) The legacy black images are near-duplicates: the median pairwise residual correlation is 0.76, so nearly every
  bin is "coherent" (median C 0.72). That set cannot separate a mark from duplication. The page's diversity check
  flags exactly this.
- (2) The legacy white files are mostly ImageMagick-processed palette PNGs; the cross-set overlap with non-palette
  black files argues against a pure palette artifact.
- (3) The strongest locations, Nyquist and quarter-band, are classic upsampling/decoder positions. Our grid band
  scores them at a 100× stricter floor, and a phase-locked bin there does not distinguish a watermark from an
  upsampler.
- (4) The solid-colour sets for the new models have about 10 images per colour. Pooled across colours they show no
  shared pattern (median pairwise residual correlation ≈ 0). That fits reverse-SynthID's own note that the mark adapts
  to content or colour, but the sets are underpowered per colour.
- (5) The averaged-magnitude Fingerprint view shows the Gemini black/white structure (fine lattice, autocorrelation
  lattice) but nothing distinctive on the content sets. A phase-locked, low-amplitude mark is expected to be invisible
  to magnitude averaging.

**Conclusion.** Our blind test independently finds frequencies that replicate (split-half far above chance) in
Google-model images and not in any camera, DALL·E or synthetic control, with some overlap between NB Pro and
Gemini 3.1. This is consistent with reverse-SynthID's core claim of a fixed, phase-locked, resolution-specific
component, and at 2816 × 1536 it coincides coarsely with its top location. It does not establish that the component
is SynthID rather than a shared Google decoder/upsampler fingerprint, and we could not test the new-model solids
with enough images. Confidence that a replicable fixed component exists in these Google images: high. Confidence that
it is the SynthID watermark: low to moderate.

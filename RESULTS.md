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

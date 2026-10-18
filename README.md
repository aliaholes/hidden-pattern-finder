# hidden-pattern-finder

Drop in pictures and check them for a pattern hiding under the content. Everything runs on your device in the
browser. The page makes no network requests: its Content-Security-Policy sets `connect-src 'none'`, and the headless
test in `tools/harness/shots.js` fails on any request that leaves the page's own origin.

**Detection only.** The page measures and shows. It never removes, weakens or rewrites a mark, and it never exports
carrier amplitudes or phases.

## How to use it

Serve the folder and open `index.html`, for example with `python3 -m http.server`. Workers need http, so opening the
file directly with `file://` won't work.

- **One image.** Drop a picture. You get:
  - the 69-view periodic-pattern scan (below);
  - **What the file says**: C2PA / Content Credentials, XMP `DigitalSourceType`, PNG text such as Stable Diffusion's
    `parameters`, and EXIF `Software`;
  - the **open watermark reader**, which decodes invisible-watermark's DWT-DCT mark and compares it with the
    published Stable Diffusion and SDXL payloads.
- **Many images.** Drop 20 to 100 or more pictures from ONE source, all the same size, up to about 4.5 MP each
  (1536 x 2816 fits). Optionally add a **control set**: same size, from a different source, such as camera photos or
  another model. You get:
  - the frequencies whose phase lines up across the set;
  - with a control, only the frequencies that line up in the set AND differ from the control;
  - **the pattern, made visible**: the set's averaged noise residual next to an image rebuilt from only the counted
    frequencies.

## Method

- **One image** (`meter.js`, port of `hidden-pattern-scan.py` v1.2).
  - Each image is turned into 69 views: colour channels, saturation boosts, high-passes, bit planes and so on.
  - Each view gets a windowed FFT on the full frame and on 4 quarters.
  - Peak prominence = height / local background (ray, ring and Nyquist-line medians).
  - Peaks on the JPEG 8 / 16 px lattice or on the image axes are labelled and kept out of the count.
  - Verdicts: PATTERN (prominence over 20.77, in 2+ views and 2+ quarters), LATTICE, WEAK, CLEAN.
  - It only sees marks that repeat *inside* one picture.
- **Many images** (`meter.js` `Coh`, port of `model-mark-scan.py` v1.1).
  - For each picture: the high-pass residual (picture minus a sigma-1.5 blur), its FFT, and one unit phasor per bin
    and channel (R, G, B, Y, Cb, Cr).
  - Agreement C = |mean phasor|, tested with Rayleigh plus Bonferroni at alpha 0.01 over all bins and channels.
  - A random circular shift per picture (the "shift null") separates position-anchored signals from chance.
  - **Grid bins** (the 8 / 16 px lattice, where JPEG seams and decoders live) are no longer dropped. They're reported
    separately and count only past a 100x stricter p-value.
- **Set vs control** (`cohCompare`).
  - Two-sample test on the mean phasors: z = |U_set/N_set - U_ctl/N_ctl|^2 / (1/N_set + 1/N_ctl), p ~ exp(-z), with
    the same Bonferroni correction. Each unit phasor has total variance <= 1, so this is approximately conservative.
  - A bin is SET-ONLY when it is anchored in the set and differs from the control.
- **The pattern, made visible** (`Coh.patternPictures`).
  - Left: the set's mean residual.
  - Right: the inverse FFT of that mean residual's spectrum, kept only at the counted bins (or only the SET-ONLY
    bins when a control is given).
  - Both are pictures, contrast-stretched, for display only.
- **DWT-DCT reader** (`wmdecode.js`).
  - Bit-exact port of invisible-watermark 0.2.0's `dwtDct` decoder: OpenCV YUV, U channel, pywt Haar cA, 4 x 4
    blocks, `|v| mod 36 > 18`. Despite the name, the library quantizes raw cA samples, not DCT coefficients, and the
    port does the same.
  - The payload length isn't stored in the image, so the reader reads 136 bits ("StableDiffusionV1", SD 1.x / 2.x
    scripts) and 48 bits (0xB3EC907BB19E, Stability generative-models / SDXL). It reports matches with a binomial
    p-value; MATCH means p < 1e-6.
- **Metadata** (`meta.js`).
  - JPEG APP1 (EXIF, XMP), JPEG APP11 JUMBF (reassembled), PNG `tEXt` / `zTXt` / `iTXt` / `eXIf` / `caBX`, and WebP
    `EXIF` / `XMP ` / `C2PA` chunks.
  - C2PA is reported as *present*, with its claim generator, actions and `digitalSourceType`. Signatures are **not**
    validated.

## Limits, and the big caveat

- **Lining up is not proof of a watermark.** Anything fixed in image coordinates lines up across a set: a decoder's
  or upscaler's fingerprint, JPEG chroma handling, a border, a vignette. In the harness, *every* clean photo set had
  1 to 2 grid bins past the strict grid floor (the Picsum JPEGs' period-2 Nyquist line). The control set removed all
  of them. Use a control.
- Content-adaptive or learned watermarks don't line up, so averaging can't see them. In the harness, rivaGan and
  Adobe TrustMark gave 0 of 4 sets, even though their own decoders read 99 %+ of bits. Neither can marks keyed to
  each picture, or marks in a diffusion model's latent noise (Tree-Ring).
- The DWT-DCT mark is fragile. JPEG q90 erased it for its own decoder (0 of 160 images decoded perfectly).
- Metadata is trivially stripped or forged. Its absence means nothing.
- SynthID: Google describes SynthID-Image as a learned post-hoc encoder/decoder (Gowal et al. 2025,
  https://arxiv.org/abs/2510.09263). Community work reports phase-locked carriers in Gemini output
  (https://github.com/aloshdenny/reverse-SynthID, not peer reviewed). This repo has no Gemini test set of its own and
  makes no claim about SynthID.
- Memory: a 1536 x 2816 set uses about 0.8 GB in the worker, about 1.1 GB with a control.

## Test results

`tools/harness/` embeds known marks into 160 Unsplash-licensed photos (Lorem Picsum, 512 x 512, 4 disjoint groups of
40), checks each mark with its own decoder, then runs the page's own JS (`meter.js`, `wmdecode.js`, `decode.js` under
node, no port). Full table: [RESULTS.md](RESULTS.md). In short:

| | sets alarmed (off-grid anchored) | vs control |
|---|---|---|
| clean / JPEG q75 / resized (12 sets) | 0 / 12 | 0 / 12 |
| dwtDct "StableDiffusionV1" | 4 / 4 | 4 / 4 |
| dwtDct SDXL 48-bit | 4 / 4 | 4 / 4 |
| dwtDct then JPEG q90 | 4 / 4 | 3 / 4 |
| dwtDctSvd | 4 / 4 | 4 / 4 |
| fixed additive pattern, 40 carriers x +-0.5 level | 4 / 4 | 4 / 4 |
| rivaGan | 0 / 4 | 0 / 4 |
| TrustMark Q | 0 / 4 | 0 / 4 |

- Grid-anchored without a control: 12 / 12 clean sets. This is the caveat above.
- DWT-DCT reader: MATCH on 113 / 160 SD-marked and 106 / 160 SDXL-marked images, and 0 / 480 clean images. Its bits
  are identical to the Python decoder on all 640 images compared.

Reproduce:

```sh
python3 -m venv venv && . venv/bin/activate
pip install invisible-watermark pillow numpy onnxruntime trustmark   # trustmark pulls torch (CPU wheels are fine)
python tools/harness/fetch_photos.py --n 160      # -> ../hpf-data/photos (+ manifest.json with sha256)
python tools/harness/make_sets.py                 # -> ../hpf-data/sets (+ decoders.json)
node tools/harness/run_detect.js                  # -> RESULTS.md
python3 -m http.server 8765 & node tools/harness/shots.js   # headless Chromium: console errors, external requests, screenshots
```

## Files

- `index.html`, `app.js`: the page.
- `worker.js`: runs the maths off the main thread.
- `meter.js`: the scan, the set test, the control test and the pattern pictures.
- `decode.js`: PIL-exact PNG reader.
- `wmdecode.js`: the DWT-DCT reader.
- `meta.js`: the metadata reader.
- `tools/harness/`: the test harness. `tools/smoke-coh.js`: a quick synthetic check of the set test.


> SynthID: tested on public Nano Banana data. No detection; the data was too small or stripped. See RESULTS.md.

## Fingerprint tab

Drop a set of images (files or a folder), plus an optional control set. Each picture's centre 512 × 512 px is taken
(never resized; offsets aligned to 8 px; pictures under 512 px are skipped). The page then computes the green-channel
noise residual: the crop minus a Gaussian blur with sigma 1.5, applied exactly in the frequency domain. It averages the
residuals' power spectra over the set.

You get:
- the log spectrum of the set and of the control
- a set / control log-ratio view
- the residual autocorrelation
- radial and azimuthal profiles
- a table of peaks with period (px) and angle (the axis cross is never ranked)

Work is streamed to a small worker pool, one file in flight per worker, with a progress bar. 300+ images run in well
under a minute. Everything stays offline. This follows Marra et al. 2019 and Corvi et al. 2023, and it is a display
only. Content, format (JPEG grid), resizing and social-site re-encoding all change the fingerprint. A difference is
suggestive, not proof, and it is not a watermark reading.

Check: `tools/harness/fp_lists.py` (Python reference) plus `tools/harness/fp_shots.js` (headless run, screenshots,
JS-vs-Python correlation).

> reverse-SynthID check: on its public dataset (reverse-SynthID by Alosh Denny, github.com/aloshdenny/reverse-SynthID),
> Many images finds frequencies that replicate across Nano Banana Pro and Gemini 3.1 images and not in camera, DALL·E or
> synthetic controls. That is consistent with a fixed phase-locked component; it is not proof that it is SynthID.
> See RESULTS.md.

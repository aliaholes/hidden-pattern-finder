# Title

Test harness with measured results, control-set test, visible pattern, metadata panel, grid reporting + DWT-DCT reader, 4.5 MP sets

# Description

Five improvements, all on-device, still no network requests (the CSP is unchanged; a headless test now also fails on
any request that leaves the page's origin). Detection only: nothing removes a mark, and no carrier amplitudes or
phases can be exported.

## What changed

1. **Test harness** (`tools/harness/`, results in `RESULTS.md`).
   - `fetch_photos.py` downloads 160 Unsplash-licensed photos from Lorem Picsum (512 x 512) and writes a manifest
     with sha256. Nothing large is committed.
   - `make_sets.py` builds 4 disjoint groups of 40 for each set:
     - marked: invisible-watermark dwtDct (SD "StableDiffusionV1", SDXL 48-bit), dwtDct then JPEG q90, dwtDctSvd,
       rivaGan, Adobe TrustMark Q, and a synthetic fixed additive pattern;
     - controls: clean, JPEG q75, resized.
     - Every mark is verified with its own decoder.
   - `run_detect.js` runs the page's own `meter.js` / `wmdecode.js` / `decode.js` under node (no port) and writes
     RESULTS.md.
   - `shots.js` loads the page in headless Chromium and fails on console errors or external requests.
2. **Control set** in Many images.
   - Adds a second drop zone, with a "Clear control" button.
   - `cohCompare` is a two-sample test on the mean unit phasors, |dU|^2 / (1/Na + 1/Nb) with an exp tail and the same
     Bonferroni correction. Only SET-ONLY bins are counted.
3. **The pattern, made visible.**
   - Shows the set's averaged high-pass residual next to an inverse FFT of that residual's spectrum, kept only at the
     counted bins (with a control: only the SET-ONLY bins).
   - Both full-frame and a 256 x 256 full-resolution tile. Pictures only.
4. **Metadata panel** (`meta.js`).
   - Reads C2PA (JPEG APP11 JUMBF reassembled, PNG caBX, WebP C2PA): presence, claim generator, actions,
     digitalSourceType. Signature not validated.
   - Also XMP `Iptc4xmpExt:DigitalSourceType`, PNG tEXt / zTXt / iTXt (SD `parameters`, ComfyUI `prompt` / `workflow`)
     and EXIF Software / Make / Model.
5. **Grid frequencies and DWT-DCT.**
   - Grid bins (8 / 16 px lattice) are now reported in their own table and count only past a 100x stricter p-value.
     New verdict: GRID-ANCHORED(n).
   - `wmdecode.js` is a bit-exact port of invisible-watermark 0.2.0's dwtDct decoder. It reads the SD 136-bit and
     SDXL 48-bit payloads with binomial p-values.
   - The Many-images cap goes from 2.4 MP to 4.5 MP: float32 accumulators, about 0.8 GB for a 1536 x 2816 set.
     It runs in Chromium.

Also:
- The README is rewritten: usage, method, limits, the caveat that alignment isn't proof, and the test results.
- The unsourced "SynthID showed 24 to 27 such frequencies in 98 Gemini images" sentence is removed. The page now
  points to the community reverse-SynthID work, labelled as not peer reviewed.

## Measured results (RESULTS.md, 4 sets of N = 40 each)

- **Clean / JPEG q75 / resized (12 sets):**
  - off-grid alarms 0 / 12, and 0 / 12 against a control;
  - **grid-anchored 12 / 12** without a control. Every clean set has the period-2 Nyquist column of the source JPEGs.
    This is why the control matters.
- **Marked sets, off-grid anchored / vs control:**
  - dwtDct SD 4/4 and 4/4;
  - dwtDct SDXL 4/4 and 4/4;
  - dwtDct + JPEG q90 4/4 and 3/4;
  - dwtDctSvd 4/4 and 4/4;
  - fixed pattern 4/4 and 4/4;
  - **rivaGan 0/4 and 0/4, TrustMark 0/4 and 0/4.** These content-adaptive marks don't line up, even though their own
    decoders read >= 99 % of bits.
- **DWT-DCT reader:**
  - MATCH on 113 / 160 SD-marked and 106 / 160 SDXL-marked images, and 0 / 480 clean images.
  - Bits identical to the Python decoder on all 640 images compared.
  - The library's own decoder recovers only 62 / 160 and 83 / 160 of those images perfectly.

## Notes for review

- `meter.js`: the diversity accumulators are now float32 instead of float64, so `rho_*` can differ from the Python
  tool at about 1e-7. The verdict maths is unchanged. The existing Rayleigh / shift-null code is untouched apart from
  the new grid-strict branch.
- The DWT-DCT payload length isn't in the image, so only the two published payloads are tested.
- Screenshots: not committed (12 MB). They can be regenerated with `tools/harness/shots.js`, or attached to the PR.

- SynthID investigation scripts (fetch_nb2.py, fetch_commons.py, banana100_pages.py, chain_fft.py, synthid_analyze.js). Result: no detection, see RESULTS.md.

### Fingerprint tab (averaged noise-residual spectra)
- New files: `fingerprint.js` (math), `fpworker.js` (streaming worker) and `fpui.js` (UI). `index.html` and `app.js` gain the tab; `meter.js` and `worker.js` are unchanged.
- The JS spectra match the Python reference (`fp_lists.py`) to float32: Pearson r = 1.0000 and max |Δ ln| = 0 on NB Pro step-1 PNGs (21), NB2-via-X JPEGs (59) and SD-marked PNGs (160). For scale, two *different* sets correlate at r ≈ 0.93 (the shared 1/f fall-off).
- 21 vs 150 images: 14 s. 160 vs 161: 5 s. Headless Chromium shows no console errors and no external requests. The existing `shots.js` run and `smoke-coh.js` still pass.
- Display only: nothing removes, subtracts or perturbs a pattern.

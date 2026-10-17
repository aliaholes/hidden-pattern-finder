# hidden-pattern-finder: improvement plan


> Status (Oct 17 2026, branch `improvements`): items 1 to 5 of the ranked list (plus the README and the unsourced claim) are implemented; see PR.md and RESULTS.md.
Written 2026-10-17. This is research only: no PR, issue or push was made. Repo: https://github.com/aliaholes/hidden-pattern-finder (7 commits, issues disabled, no PRs).

## 1. What the repo does today

It is a static, offline web page (`index.html`, `app.js`, `worker.js`, `meter.js`, `decode.js`). The CSP sets `connect-src 'none'`, so nothing gets uploaded. The code is a JavaScript port of two Python tools that live in a *separate, unpublished* "FABLEALIA" repo (`tools/hidden-pattern-scan.py` v1.2, `tools/model-mark-scan.py` v1.1).

**One image mode** (`meter.js scanPerm/decide`)
- Builds 69 "views": colour channels, HSV/LAB saturation boosts, Gaussian high-pass at sigma 1/2/4/8, and others. Each view is scanned on the full frame plus 4 quarter crops.
- Each scan is a windowed FFT. Peak prominence is S / max(ray, ring, Nyquist-line medians). Peaks on the JPEG 8/16 px lattice or on an axis get labelled and set aside.
- Verdicts are PATTERN, LATTICE, WEAK or CLEAN. The thresholds are frozen (T = 20.77, T_lattice = 23.84): 1.25 times the maximum seen on 24 "clean" images.
- This mode only finds marks that repeat *inside* one picture. The page says so.

**Many images mode** (`meter.js Coh`)
- Takes N images that all have the same size. For each one it computes a high-pass residual (image minus a 13-px blur) and a per-bin FFT unit phasor per channel, then sums the phasors.
- Coherence C = |mean phasor|. A Rayleigh test with Bonferroni correction over all bins and channels gives the threshold C*.
- A "shift null" re-sums each image after a random circular roll. A bin that stays coherent after the rolls isn't anchored to position.
- A "grid blind band" excludes bins near multiples of H/16 and W/16. A diversity check warns when the images share content.
- Verdicts are ANCHORED-CARRIERS(n), GRID-ONLY or NONE.
- This is the right primitive for SynthID-style fixed-key carriers. It is the same idea as reverse-SynthID's phase-coherence analysis (see §2).

**What I ran:** `tools/smoke-coh.js` (node 20, added locally, not committed). It feeds 128x128 synthetic images (varying content plus noise) with a fixed-phase cosine carrier at bin (5,11) into `Coh`. Results:

| carrier amplitude (8-bit levels) | N | verdict |
|---|---|---|
| 0 (null) | 40 | NONE |
| 0.5 | 40 | ANCHORED-CARRIERS(1), bin 5,11, C=0.91 |
| 1 / 2 | 40 | ANCHORED, C=0.98 / 0.99 |
| 1 | 100 | ANCHORED, C=0.98 |

The core math works and is sensitive (it finds a sub-1-level carrier at N=40). I did not run the browser UI.

### Bugs, gaps, test coverage
- **No tests ship with the repo.** `decode.js` mentions a "bun test harness" and receipts in `Experiments/...page-test-w4/`, and neither is in this repo. Nobody else can re-check the frozen thresholds or the claimed parity with the Python tools.
- **The 24-image null set is unpublished.** T = 1.25 x max over 24 images gives very weak false-positive control for 69 views x 5 regions x about 150 peaks. There is no stated FP rate.
- **The README is two lines.** No method, no limits, no citations.
- **The headline claim can't be verified.** `app.js` says "SynthID showed 24 to 27 such frequencies in 98 Gemini images", but there's no dataset, script or output in the repo.
- **The blind band hides real targets.** The grid band (multiples of H/16 and W/16, ±1 bin) covers the 8 px block lattice. The Stable Diffusion `invisible-watermark` DWT-DCT mark works on 4x4 blocks of the level-1 DWT LL band, which is 8x8 px blocks, so its energy lands *in* the blind band. The page would say "GRID-ONLY" for exactly the open-model watermark that is easiest to verify.
- **The size cap is too low.** The Many-images cap is 2.4 MP, and reverse-SynthID reports Gemini outputs at 1536x2816 (4.3 MP). Mixed-size sets are refused instead of being grouped by size, and carriers depend on resolution, so per-size grouping is the right model.
- **Nothing is shown in pixel space.** "Make the pattern visible" currently means a coherence map of bins. There is no reconstructed spatial pattern, no mean residual image, and no comparison against a control set.
- **There is no control set.** Every ANCHORED result carries the text "only a test against matched pictures from another source can tell those apart", but the tool doesn't offer that test.
- **Metadata is ignored.** C2PA/JUMBF, XMP `DigitalSourceType = trainedAlgorithmicMedia`, and IPTC fields are the cheapest and most reliable "AI-generated" signals, and they're not read.
- **The residual is crude.** Blur-difference residuals leak edge content. A wavelet or BM3D-type denoiser residual gives a cleaner noise estimate (the standard approach in PRNU and generator-fingerprint work).
- Minor issues:
  - Browser JPEG decoders differ from PIL's (D7). Parity tests only cover PNG.
  - One-image mode silently takes only the first dropped file.
  - Rayleigh assumes independent images. Near-duplicate sets are only warned about, not blocked.

## 2. What is actually known (primary sources)

- **SynthID-Image** is a deep-learning post-hoc encoder/decoder, model-independent, and has marked more than 10B images. The paper describes threat models but no carrier structure. Gowal et al. 2025, https://arxiv.org/abs/2510.09263 ; https://deepmind.google/technologies/synthid/
- **SynthID-Text** is open-source, but it's a different system (tournament sampling over logits). Nothing about it transfers to images. https://www.nature.com/articles/s41586-024-08025-4 , https://github.com/google-deepmind/synthid-text
- **Public reverse engineering of SynthID-Image.** https://github.com/aloshdenny/reverse-SynthID asks Gemini to "recreate" pure black/white/colour images. It then finds FFT bins whose phase is locked across about 100+ outputs (coherence > 0.99). The strongest signal is in green. Carriers depend on resolution (e.g. (9,9), (5,5), (10,11) at 1024²). PR #23 reports the carriers depend on content (dark images: diagonal (±3,±4); white images: horizontal-axis bins) and gives 99% detection with 0/16 false positives on a *small* negative set. Treat these as community claims, not peer-reviewed. The repo also ships a removal pipeline (V3/V4); see §4.
- **Averaging attacks in general.** Averaging many watermarked images reveals any *content-agnostic* mark (Tree-Ring, DwtDctSvd, RoSteALS, Gaussian Shading, RAW). Content-adaptive marks resist it. Yang et al., NeurIPS 2024, https://arxiv.org/abs/2406.09026 , code https://github.com/showlab/watermark-steganalysis
- **UnMarker**: a universal removal attack that targets spectral amplitudes. Kassis & Hengartner, IEEE S&P 2025, https://arxiv.org/abs/2405.08363
- **WAVES**: a benchmark of watermark robustness and attacks. https://arxiv.org/abs/2401.08573 , https://github.com/umd-huang-lab/WAVES
- **Tree-Ring**: the mark is in the Fourier domain of the initial *latent* noise, so it doesn't show directly in the pixel FFT. https://arxiv.org/abs/2305.20030
- **Stable Signature**: the mark is fine-tuned into the latent decoder and is content-adaptive. https://arxiv.org/abs/2303.15435 , https://github.com/facebookresearch/stable_signature
- **StegaStamp**: an encoder-decoder network. https://arxiv.org/abs/1904.05343
- **invisible-watermark** (`dwtDct`, `dwtDctSvd`, `rivaGan`): used by the SD reference scripts and SDXL. It has a decoder, so this is ground truth we can embed and read back. https://github.com/ShieldMnt/invisible-watermark
- **Meta**: Video Seal https://arxiv.org/abs/2412.09492 , AudioSeal https://arxiv.org/abs/2401.17264 , Watermark Anything https://arxiv.org/abs/2411.07231 (all open, so embed and detect is possible).
- **Adobe TrustMark** (open, used alongside Content Credentials): https://arxiv.org/abs/2311.18297 , https://github.com/adobe/trustmark
- **C2PA / Content Credentials**: https://c2pa.org/specifications/ . OpenAI attaches C2PA to DALL·E 3 and gpt-image outputs: https://help.openai.com/en/articles/8912793-c2pa-in-chatgpt-images . Google adds IPTC/C2PA metadata alongside SynthID. Metadata is trivially stripped, but when it's present it's decisive.
- **Generator fingerprints vs watermarks**: diffusion and GAN outputs leave spectral peaks from upsampling even without any watermark (Corvi et al. https://arxiv.org/abs/2211.00680 ; Durall et al. https://arxiv.org/abs/2003.01826). This is the main confound: an "anchored" bin may be the architecture, not a mark.

**What is feasible:**
- Averaging residuals or phases over many same-generator, same-size images is proven to work for fixed-key marks.
- One image alone won't reveal a non-periodic mark.
- Content-adaptive or keyed marks (Stable Signature, StegaStamp-style) won't show up by averaging.
- Tree-Ring needs DDIM inversion, which a browser tool can't do.
- For open marks the honest route is to run their decoder.

## 3. Ranked improvements (impact / effort)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| 1 | Ground-truth test harness (open watermarkers + real-photo control) | very high | M |
| 2 | Control-set (two-sample) mode in Many images | very high | M |
| 3 | Make the pattern visible in pixel space (reconstruct carriers / mean residual) | high | S |
| 4 | Metadata panel: C2PA/JUMBF, XMP DigitalSourceType, IPTC, PNG text chunks | high | S |
| 5 | Unblind the grid band, or flag it; add a direct invisible-watermark DWT-DCT decoder | high | M |
| 6 | Publish the null set and recalibrate thresholds to a stated FP rate | high | M |
| 7 | Raise size cap / stream, group mixed sizes automatically | medium | S–M |
| 8 | Better residual (wavelet / BM3D-lite denoiser) as an option | medium | M |
| 9 | README with method, limits, citations; remove unverifiable claims or back them with data | medium | S |
| 10 | Cross-colour / cross-subset consensus and split-half replication of carriers | medium | S |

### 1. Test harness
**What:** add `tests/` with node (or bun) scripts that call `meter.js` directly, which already works under node (see `tools/smoke-coh.js`), plus a Python fixture generator:
- **(a) Synthetic carriers:** sweep amplitude, N, frequency, and on-grid vs off-grid placement. Assert detection when it's above a known SNR and NONE on nulls. Run 200 null seeds to measure the empirical FP rate.
- **(b) Open watermarks:** take 100 real photos (e.g. RAISE or a COCO subset, same crop size). Embed with `invisible-watermark` dwtDct/dwtDctSvd/rivaGan, TrustMark, Stable Signature, Video Seal (per frame), with a fixed message and a random message. Check the decoder recovers the bits, which confirms the embed worked. Then assert:
  - fixed-message dwtDct is detected, or at least lands in the GRID band with the expected 8 px structure;
  - random-message sets behave as documented;
  - the same 100 photos un-watermarked give NONE.
- **(c) Confound controls:**
  - real-camera JPEG sets at Q 75/90/95 (8x8 blocks);
  - demosaiced RAW (Bayer period-2 peaks);
  - resized/upscaled sets (interpolation peaks);
  - an unwatermarked diffusion model (e.g. SD without the watermark hook) to measure the "architecture fingerprint" rate.

**Verify:** a CI table of TPR/FPR per method, committed so the numbers in the UI copy come from it.

### 2. Control-set mode
**What:** in Many images, add a second drop zone for a reference set of the same size from another source.
- Run Coh on both sets. Report bins significant in A and not in B, using a two-sample test on phasor means (or a permutation test that shuffles the A/B labels).
- Show the A-only bins in red.

**Why:** this separates a watermark from shared decoder/JPEG/upsampling fingerprints. The page's own text already says this is the missing step.

**Verify:** with harness (b), dwtDct-marked vs unmarked photos should give A-only bins. Unmarked vs unmarked from two cameras should give none, or only grid bins.

### 3. Show the pattern
**What:** after `evaluate`, inverse-FFT the significant bins using their mean phase and an amplitude estimate (mean complex coefficient, not the unit phasor). Render a tiled, contrast-stretched pattern image per channel. Optionally also show the plain mean residual (sum of residuals / N), which is the Yang et al. eq. 2 view.

**Why:** the repo's stated goal is "make it visible". Today the user sees only dots on a spectrum.

**Verify:** a synthetic carrier comes back with correlation > 0.9 to the inserted pattern. On dwtDct, the 8 px block structure appears.

### 4. Metadata panel
**What:** parse JPEG APP11/JUMBF and PNG `caBX` (C2PA), XMP (`Iptc4xmpExt:DigitalSourceType`), and PNG tEXt/iTXt (e.g. SD "parameters"). Show "C2PA manifest present (claim generator: …)". Full signature validation would need c2pa-js. Even presence-only is useful.

**Verify:** use DALL·E/gpt-image downloads (C2PA), Gemini downloads (IPTC/XMP), and stripped copies.

### 5. Grid band
**What:** stop dropping grid bins silently.
- Report anchored grid bins separately with a stricter threshold, plus a check that compares them to the JPEG-control expectation.
- Add an optional DWT-DCT decoder port (`invisible-watermark` dwtDct is about 100 lines: Haar DWT, 4x4 DCT on LL, quantization-index bit read) that prints the recovered bits and their consistency across the set.

**Verify:** with harness (b) dwtDct, the decoded bits should match the embedded message at > 95% bit accuracy on PNG and degrade gracefully on JPEG.

### 6. Calibration
Publish the 24 null images (or a public 500+ null set: RAISE, Dresden, COCO). Set T from a target per-image FP rate (e.g. 1%) with a bootstrap CI. Document the rate in the UI.

### 7. Sizes
Group the dropped files by stored size and run Coh per group. Raise the cap by processing per-channel and per-row-block, or by accumulating in a worker with float32 (memory is about H·(W/2+1)·channels·16 B). That covers 1536x2816.

### 8. Residual
Offer a wavelet-shrinkage denoiser (Mihcak-style, the PRNU standard) as the residual option. Measure the coherence gain on harness (a)/(b) at a fixed N.

### 9. Docs
Write a README covering the method, the limits (keyed, content-adaptive and latent marks are invisible), and the citations above. Either back the "24 to 27 frequencies in 98 Gemini images" claim with a reproducible script and data hashes, or soften it.

### 10. Replication
Split the set into halves A/B and report only carriers significant in both, with phase agreement |cos Δφ| > 0.9. This mirrors reverse-SynthID's black/white cross-validation and cuts flukes.

## 4. Ethics / legal (brief)
- Detecting and visualising a watermark is analysis. It's broadly fine, and the repo's "detection only" stance is correct.
- Avoid shipping subtraction or "bypass" code (reverse-SynthID V3/V4 does). A carrier codebook with amplitudes and phases is effectively a removal or forgery kit: Yang et al. show the extracted pattern can be subtracted or added to forge marks.
- Removing provenance marks can raise issues under the EU AI Act Art. 50 transparency duties, and possibly DMCA §1202 (removal of copyright management information), plus the generators' ToS.
- Keep outputs at the "which bins, how coherent" level, and don't publish amplitude/phase tables for proprietary marks.
- Generating large Gemini sets to study SynthID may hit API ToS limits. Use your own legitimately obtained outputs.

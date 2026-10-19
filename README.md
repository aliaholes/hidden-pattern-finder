# Hidden Pattern Finder

A page that looks for repeating or fixed patterns hidden in pictures: the kind of regular structure a camera, an
upscaler, a decoder or a watermark can leave behind. It measures; it never removes, weakens or rewrites anything in a
picture.

**Everything runs in your browser.** Pictures are read from your own disk into this page and never uploaded. The page
makes no network requests (its Content-Security-Policy forbids them), and the heavy work runs in Web Workers on your
device.

## The three tabs

### One image

Drop one picture. The page looks at it through 69 views (colour channels, contrast lifts, residuals, and its four
quarters) and searches each view's spectrum for a peak that repeats.

- **The verdict** says whether a repeat was found and how sure the page is:
  - **PATTERN**: one repeat (same period and angle) crossed the threshold in at least 2 views AND at least 2 quarters.
  - **WEAK**: something crossed the threshold but did not recur widely enough. The box says which condition failed.
    A real but faint repeat often scores about half as much in a quarter of the picture, so it can miss there. Treat
    WEAK as a maybe.
  - **LATTICE**: a strong grid recurs exactly on the 8 / 16 px block lattice that JPEG and WebP compression use.
    Block-aligned content (pixel art, a UI grid, an upscaler) can do this; it is not called hidden data.
  - **CLEAN**: nothing crossed the threshold.
  - A separate note appears when the 8 x 8 block grid is strong. That grid comes from the compression itself and is
    never reported as hidden data.
- **Size:** pictures up to 4096 px on the long side are analysed at full size. Bigger ones are shrunk by a whole
  number (every k x k block averaged into one pixel), so the compression grid stays on its grid.
- **What the file says:** the file's own metadata, read from its bytes: C2PA / Content Credentials (present or not;
  signatures are NOT checked), XMP (including the IPTC "digital source type", which can say "made by a trained AI
  model"), PNG text (some generators store their settings there) and EXIF. Lines marked **AI** are the file declaring
  itself AI-made. Metadata is easy to strip or fake, so missing metadata means nothing.
- **Open watermark reader (DWT-DCT):** reads the open "invisible-watermark" dwtDct mark that the Stable Diffusion
  reference scripts and SDXL embed, from the picture's full-size pixels (pictures up to 40 megapixels). It reports how
  many bits match each known message and the chance of that many matching by luck. The mark is fragile: a resize, a
  crop or strong JPEG erases it, so "no match" is the normal result.

### Many images

Drop a set of pictures from ONE source (one model, one camera), all the same size; at least about 20, and 50 to 100 is
better. Up to about 4.5 megapixels each. Pictures are never resized.

Content changes from picture to picture, so its phases scatter. Something fixed in image coordinates (a watermark, a
border, a decoder's fingerprint) has the same phase in every picture and "lines up". The page counts frequencies that
line up more than chance allows (with a correction for the number of tests), checks them against shifted copies, and
lists the strongest.

- Frequencies on the 8 / 16 px grid (where compression seams live) only count past a 100x stricter test, and are
  listed separately.
- **Control set (optional):** pictures of the same size from a different source. A frequency then counts as the set's
  own only if it lines up in the set AND differs from the control. A small control can only test strong frequencies:
  the answer says when the control was too small, and how many control pictures would be needed. A control that is
  too small is never reported as "nothing beyond the control". A frequency counts as shared with the control only
  when the control itself lines up there; when the control shows nothing there and the test cannot tell, the answer
  says "undecided" and asks for more control pictures.
- **The pattern, made visible:** the set's fine grain (each picture minus a blurred copy), averaged, and the same
  average keeping only the counted frequencies. Both are shrunk for the screen, to at most 512 px and always to at
  most half the set's size (a 512 x 512 set is shown at 256 x 256), and contrast-stretched.
  They are pictures to look at, not measurements, and the page does not export them.

### Fingerprint

Drop a set (files or a whole folder), and optionally a control set. Each picture's centre 512 x 512 px is cut out (no
resizing; pictures under 512 px or over 40 megapixels are skipped), its fine grain is taken, and the power spectra are
averaged over the set. Content averages out; what the camera or generator adds the same way every time stays.

You get the averaged spectrum (log power), the set-over-control ratio if you gave a control, the autocorrelation (a
repeat shows as a lattice of spots), radial and directional profiles, and a table of the strongest peaks.

This follows Marra et al. 2019 ("Do GANs leave artificial fingerprints?") and Corvi et al. 2023 ("On the detection of
synthetic images generated by diffusion models").

## How to read the answers

- A found pattern says something about **how** a picture was made. It is not proof of hidden data, and not proof of
  a watermark.
- "Lines up" is not proof of a watermark either: anything fixed in image coordinates lines up. A control set from
  another source is the way to rule shared things out.
- A different-looking fingerprint means the pictures were made differently. It doesn't say by what.
- "Nothing found" is never "clean".

## What it cannot tell you

- A mark that changes with every picture, adapts to the content, or is not periodic at all, is invisible to the One
  image and Many images tests.
- One image can only show a pattern that repeats inside that picture. A mark that is fixed across pictures but does
  not repeat inside one needs the Many images tab.
- Stripes exactly aligned with the picture's edges are ignored on purpose, so compression blocks and resizing don't
  cry wolf. A mark hidden there is missed.
- Social sites recompress and resize pictures, which usually wipes these traces.
- Signed metadata is only seen, never verified.

## Files

| File | What it does |
|---|---|
| `index.html` | the page |
| `app.js` | One image and Many images: decoding, the worker pool, the verdicts |
| `meter.js` | the measurements (spectra, peaks, the coherence test, the control test) |
| `worker.js` | runs `meter.js` and the DWT-DCT reader off the main thread |
| `decode.js` | reads pictures the same way the command-line scanner does (PNG exactly; stored orientation) |
| `meta.js` | the metadata reader (C2PA, XMP, PNG text, EXIF) |
| `wmdecode.js` | the DWT-DCT watermark reader |
| `spectrum.js`, `fpworker.js`, `fpui.js` | the Fingerprint tab |

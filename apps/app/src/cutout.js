// Background removal for profile photos, entirely in the browser (the photo never leaves the device until the result is uploaded).
// MediaPipe's selfie segmenter (a ~250 KB model) finds the person; everything else becomes transparent so the photo sits on the
// white player card like a cut-out. Web only; callers fall back to the plain photo if anything here fails.
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let segmenter;
async function load() {
  segmenter ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(WASM);
    return ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });
  })().catch((e) => { segmenter = undefined; throw e; });
  return segmenter;
}

const smooth = (v, lo = 0.3, hi = 0.7) => { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

/** File/Blob in → PNG Blob with a transparent background, cropped to the person. Throws if no person is found. */
export async function removeBackground(file, max = 1024) {
  const seg = await load();
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const photo = document.createElement('canvas'); photo.width = w; photo.height = h;
  const pc = photo.getContext('2d'); pc.drawImage(bmp, 0, 0, w, h);

  const res = seg.segment(photo);
  const mask = res.confidenceMasks?.[0];
  if (!mask) throw new Error('No person found');
  const conf = mask.getAsFloat32Array();
  const mw = mask.width, mh = mask.height;
  res.close?.();

  // the model may mark the person with high or low values: the frame's border is almost always background
  let border = 0, n = 0;
  for (let x = 0; x < mw; x++) for (const y of [0, mh - 1]) { border += conf[y * mw + x]; n++; }
  for (let y = 0; y < mh; y++) for (const x of [0, mw - 1]) { border += conf[y * mw + x]; n++; }
  const flip = border / n > 0.5;

  const a = document.createElement('canvas'); a.width = mw; a.height = mh;
  const ac = a.getContext('2d'); const img = ac.createImageData(mw, mh);
  let minX = mw, minY = mh, maxX = 0, maxY = 0, hits = 0;
  for (let i = 0; i < conf.length; i++) {
    const v = smooth(flip ? 1 - conf[i] : conf[i]);
    img.data[i * 4 + 3] = Math.round(v * 255);
    if (v > 0.5) { const x = i % mw, y = (i / mw) | 0; hits++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (hits < mw * mh * 0.03) throw new Error('No person found');
  ac.putImageData(img, 0, 0);

  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const oc = out.getContext('2d');
  oc.drawImage(photo, 0, 0);
  oc.globalCompositeOperation = 'destination-in';
  oc.filter = 'blur(1.2px)';
  oc.drawImage(a, 0, 0, w, h);

  const sx = w / mw, sy = h / mh, pad = 0.03 * Math.max(w, h);
  const cx = Math.max(0, minX * sx - pad), cy = Math.max(0, minY * sy - pad);
  const cw = Math.min(w, (maxX + 1) * sx + pad) - cx, ch = Math.min(h, (maxY + 1) * sy + pad) - cy;
  const crop = document.createElement('canvas'); crop.width = Math.round(cw); crop.height = Math.round(ch);
  crop.getContext('2d').drawImage(out, cx, cy, cw, ch, 0, 0, crop.width, crop.height);
  const blob = await new Promise((r) => crop.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not encode the cut-out');
  return blob;
}

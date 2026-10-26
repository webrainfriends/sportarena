# Puts the REAL app screens onto the phone each person is holding.
# The portraits are generated with the phone screen facing the camera as a flat chroma-green (#00FF00). For each portrait this:
#   1. upscales it to 2160px wide (Lanczos + light sharpen + grain),
#   2. finds the green screen and its four corners,
#   3. warps a real app capture (shots/<name>.jpg) into those corners in perspective,
#   4. writes people-hi/<portrait>__<screen>.jpg, and the screen's centre/size to people-hi/quads.json (the Reel zooms toward it).
# Only green pixels are replaced, so fingers, hair and anything in front of the screen stay in front.
# Usage: python3 -I composite-screens.py            (all portraits in SCENES)
#        python3 -I composite-screens.py home       (just one portrait)
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

# portrait -> the real captures shown on that person's phone, in order
SCENES = {
    'home':       ['home'],
    'tournament': ['event_console', 'event_table'],
    'venue':      ['venues', 'schedule'],
    'coach':      ['coaches'],
    'athlete':    ['player', 'insights', 'workspace'],
    'physio':     ['health', 'health_pros'],
    'doctor':     ['doctor'],
    'learning':   ['learn'],
    'sponsor':    ['sponsor'],
    'team':       ['explore_teams', 'explore_people'],
}
OUT_W = 2160
BG = (229, 234, 245)   # the app's mist canvas, used to letterbox a phone capture on a wider tablet screen
rng = np.random.default_rng(7)

def green_mask(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    return (g > 120) & (g > r * 1.55) & (g > b * 1.55)

def corners(mask):
    ys, xs = np.nonzero(mask)
    cx, cy = np.median(xs), np.median(ys)
    keep = (np.abs(xs - cx) < 3.2 * xs.std() + 8) & (np.abs(ys - cy) < 3.2 * ys.std() + 8)
    xs, ys = xs[keep], ys[keep]
    s, d = xs + ys, xs - ys
    tl, br = (xs[s.argmin()], ys[s.argmin()]), (xs[s.argmax()], ys[s.argmax()])
    tr, bl = (xs[d.argmax()], ys[d.argmax()]), (xs[d.argmin()], ys[d.argmin()])
    return np.array([tl, tr, br, bl], float)

def persp_coeffs(dst, src):
    """PIL wants the map from OUTPUT (photo) points to INPUT (ui) points."""
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]; B += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(B, float))

def fit_ui(ui, quad):
    """Letterbox the phone capture to the aspect of the quad (a tablet is wider than a phone)."""
    w = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
    h = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
    target = w / h; cur = ui.width / ui.height
    if abs(target - cur) / cur < 0.18: return ui
    if target > cur:
        W = round(ui.height * target); out = Image.new('RGB', (W, ui.height), BG); out.paste(ui, ((W - ui.width) // 2, 0))
    else:
        H = round(ui.width / target); out = Image.new('RGB', (ui.width, H), BG); out.paste(ui, (0, (H - ui.height) // 2))
    return out

def run(name):
    src = Image.open(f'people/{name}.jpg').convert('RGB')
    k = OUT_W / src.width
    photo = src.resize((OUT_W, round(src.height * k)), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=2.2, percent=90, threshold=2))
    a = np.asarray(photo)
    m = green_mask(a)
    if m.sum() < 4000: raise SystemExit(f'{name}: no green screen found ({int(m.sum())} px) - regenerate that portrait')
    quad = corners(m)
    mask_img = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.1))
    mk = np.asarray(mask_img).astype(np.float32)[..., None] / 255
    meta = {'cx': float(quad[:, 0].mean() / OUT_W), 'cy': float(quad[:, 1].mean() / photo.height),
            'w': float(np.linalg.norm(quad[1] - quad[0]) / OUT_W), 'h': float(np.linalg.norm(quad[3] - quad[0]) / photo.height), 'quad': quad.tolist(), 'size': [OUT_W, photo.height]}
    os.makedirs('people-hi', exist_ok=True)
    grain = rng.normal(0, 3.2, (photo.height, OUT_W, 1))
    base = np.clip(a.astype(np.float32) + grain, 0, 255)
    for cap in SCENES[name]:
        ui = fit_ui(Image.open(f'shots/{cap}.jpg').convert('RGB'), quad)
        uw, uh = ui.size
        co = persp_coeffs(quad, [(0, 0), (uw, 0), (uw, uh), (0, uh)])
        warped = ui.transform(photo.size, Image.PERSPECTIVE, co, Image.BICUBIC)
        w = np.asarray(warped).astype(np.float32)
        # a touch of realism: slight dimming and a little bloom onto the surroundings
        w = w * 0.96 + 10
        out = base * (1 - mk) + w * mk
        bloom = np.asarray(Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(26))).astype(np.float32)
        halo = np.asarray(Image.fromarray((mk[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(40))).astype(np.float32)[..., None] / 255
        out = np.clip(out + 0.10 * halo * bloom * (1 - mk), 0, 255)
        Image.fromarray(out.astype(np.uint8)).save(f'people-hi/{name}__{cap}.jpg', quality=94)
        print('wrote', f'people-hi/{name}__{cap}.jpg')
    return meta

if __name__ == '__main__':
    names = sys.argv[1:] or list(SCENES)
    qp = 'people-hi/quads.json'
    quads = json.load(open(qp)) if os.path.exists(qp) else {}
    for n in names: quads[n] = run(n)
    os.makedirs('people-hi', exist_ok=True); json.dump(quads, open(qp, 'w'), indent=1)

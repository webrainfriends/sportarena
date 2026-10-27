# Upscales the generated portraits to 2160px wide (Lanczos), sharpens and adds a little film grain so they hold up at 4K.
# Usage: python3 -I enhance.py   (reads people/*.jpg, writes people-hi/*.jpg)
import glob, os, numpy as np
from PIL import Image, ImageFilter
os.makedirs('people-hi', exist_ok=True)
rng = np.random.default_rng(7)
for f in glob.glob('people/*.jpg'):
    im = Image.open(f).convert('RGB'); w, h = im.size; k = 2160 / w
    im = im.resize((2160, round(h * k)), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=2.2, percent=90, threshold=2))
    a = np.asarray(im).astype(np.float32) + rng.normal(0, 3.2, (im.size[1], im.size[0], 1))
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save('people-hi/' + os.path.basename(f), quality=94)
    print(f)

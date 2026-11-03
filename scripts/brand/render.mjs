// Regenerates the GotMyGame wordmark artwork (transparent PNGs) used by the app and the PDFs:
//   NODE_PATH=$(npm root -g) node scripts/brand/render.mjs   (needs Playwright; writes apps/app/assets/brand and apps/api/assets/brand)
// Lettering: Exo 2 Black Italic (SIL OFL, scripts/brand/fonts) widened, with a silver chrome face, glossy purple "Game", dark outline and bevel.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const targets = [path.join(root, 'apps/app/assets/brand'), path.join(root, 'apps/api/assets/brand')];
const jobs = [['wordmark', 'light', 'name'], ['wordmark-tagline', 'light', 'full'], ['wordmark-tagline-dark', 'dark', 'full']];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 620 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'wordmark.html'));
for (const [file, variant, mode] of jobs) {
  await page.evaluate(([v, m]) => window.build(v, m), [variant, mode]);
  await page.waitForTimeout(300);
  // trim to the drawn artwork: ask the page for the bounding box of the svg content
  const box = await page.evaluate(() => { const b = document.getElementById('root').getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
  const pad = 12;
  const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(1800, box.width + pad * 2), height: Math.min(620, box.height + pad * 2) };
  const buf = await page.screenshot({ omitBackground: true, clip });
  for (const dir of targets) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${file}.png`), buf); }
  console.log(file, clip.width, 'x', clip.height);
}
await browser.close();

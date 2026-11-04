// Process guides: the step-by-step "how to set up" card shown on the academy landing page, with real screenshots and a PDF download.
// The content is generic product guidance (no personal or organisation data), so any signed-in user may read it. The steps, the
// screens they open and the screenshots all come from src/guides/academy-process.js, which test/process-guide.test.js keeps in step
// with the organisation / academy modules.
import fs from 'node:fs';
import { z } from 'zod';
import { cap } from '../registry.js';
import { notFound } from '../errors.js';
import { GUIDE_PERSONAS, SHOT_SIZES } from '../guides/academy-process.js';
import { renderGuidePdf, shotPath } from '../guides/render.js';

const TAG = 'Process guides';
const persona = z.enum(Object.keys(GUIDE_PERSONAS));
const TITLES = { academy: 'Academy onboarding guide' };
const stepsOf = (p) => GUIDE_PERSONAS[p] ?? (() => { throw notFound('Guide'); })();
const hasShot = (p, id, size) => fs.existsSync(shotPath(p, id, size));

cap({
  name: 'get_process_guide', method: 'GET', path: '/process-guides/:persona', tag: TAG,
  summary: 'The ordered, step-by-step setup guide for a kind of organisation (academy): what to do, where to tap, and which screenshots exist',
  input: z.object({ persona }),
  handler: async (_ctx, { persona: p }) => ({
    persona: p, title: TITLES[p],
    steps: stepsOf(p).map((s, i) => ({ id: s.id, number: i + 1, title: s.title, why: s.why, steps: s.steps, target: s.target, screenshots: Object.fromEntries(Object.keys(SHOT_SIZES).map((size) => [size, hasShot(p, s.id, size)])) })),
  }),
});

cap({
  name: 'get_process_guide_screenshot', method: 'GET', path: '/process-guides/:persona/steps/:step/screenshot/:size', tag: TAG,
  summary: 'One screenshot of a guide step as a base64 PNG (size phone or desktop)',
  input: z.object({ persona, step: z.string().max(40), size: z.enum(Object.keys(SHOT_SIZES)) }),
  handler: async (_ctx, { persona: p, step, size }) => {
    if (!stepsOf(p).some((s) => s.id === step) || !hasShot(p, step, size)) throw notFound('Screenshot');
    return { content_type: 'image/png', encoding: 'base64', content: fs.readFileSync(shotPath(p, step, size)).toString('base64') };
  },
});

cap({
  name: 'get_process_guide_pdf', method: 'GET', path: '/process-guides/:persona/pdf', tag: TAG,
  summary: 'The whole guide with its screenshots as a PDF (English)',
  input: z.object({ persona }),
  handler: async (_ctx, { persona: p }) => {
    const buffer = await renderGuidePdf({ persona: p, title: TITLES[p], steps: stepsOf(p) });
    return { filename: `${p}-onboarding-guide.pdf`, content_type: 'application/pdf', encoding: 'base64', content: buffer.toString('base64'), language: 'en' };
  },
});

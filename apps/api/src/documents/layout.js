// The constrained document schema a template is stored as. Templates are data, never code: only these block types exist, text is
// plain, and there is no expression, URL or HTML anywhere, so the renderer has nothing executable to run or fetch.
import { z } from 'zod';

export const BLOCKS = ['header', 'title', 'parties', 'lines', 'totals', 'text', 'footer'];
/** Blocks an invoice can never be issued without: a template cannot hide the canonical number, parties, lines or totals. */
export const REQUIRED = { invoice: ['title', 'parties', 'lines', 'totals'] };

const block = z.object({ type: z.enum(BLOCKS), text: z.string().max(2000).optional(), align: z.enum(['left', 'center', 'right']).optional(), size: z.enum(['small', 'normal', 'large']).optional() }).strict()
  .refine((b) => b.type === 'text' ? !!b.text?.trim() : b.text === undefined && b.align === undefined && b.size === undefined, 'Only text blocks carry text, alignment and size, and they need some text');

export const layoutSchema = z.object({
  style: z.enum(['classic', 'modern']).default('classic'),
  paper: z.enum(['A4', 'Letter']).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  margin_mm: z.number().int().min(10).max(30).default(18),
  blocks: z.array(block).min(1).max(20),
}).strict();

export const STARTERS = {
  classic: { style: 'classic', paper: 'A4', orientation: 'portrait', margin_mm: 18, blocks: ['header', 'title', 'parties', 'lines', 'totals', 'footer'].map((type) => ({ type })) },
  modern: { style: 'modern', paper: 'A4', orientation: 'portrait', margin_mm: 15, blocks: ['header', 'title', 'parties', 'lines', 'totals', 'text', 'footer'].map((type) => (type === 'text' ? { type, text: 'Thank you for your business.' } : { type })) },
};

/** Parse a layout and make sure the family's mandatory blocks are all present. Returns the parsed layout or throws a message. */
export function checkLayout(family, raw) {
  const r = layoutSchema.safeParse(raw);
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'layout'}: ${i.message}`).join('; ') };
  const missing = (REQUIRED[family] ?? []).filter((t) => !r.data.blocks.some((b) => b.type === t));
  if (missing.length) return { error: `A ${family} layout must keep these blocks: ${missing.join(', ')}` };
  return { layout: r.data };
}

const SOURCE = (available, reason) => ({ available, ...(reason ? { reason } : {}) });
/** What each role can produce and whether its canonical source workflow is wired up yet. Only invoices are; the rest are listed honestly as not available. */
export const FAMILIES = [
  { family: 'invoice', label: 'Venue invoice / credit note', roles: ['venue_manager', 'athlete', 'organizer', 'coach'], source: SOURCE(true) },
  ...[
    ['coaching_plan', 'Training / coaching plan', ['coach']], ['coach_agreement', 'Coaching agreement', ['coach']],
    ['referee_letter', 'Appointment / engagement letter', ['referee']], ['event_timetable', 'Event programme / timetable', ['organizer']],
    ['booking_confirmation', 'Booking confirmation', ['organizer', 'venue_manager']], ['rehab_plan', 'Rehabilitation / exercise plan', ['physio']],
    ['care_plan', 'Approved care plan', ['doctor']], ['purchase_order', 'Purchase order / delivery note', ['supplier']],
    ['sponsorship_agreement', 'Sponsorship agreement', ['sponsor']], ['hire_agreement', 'Venue hire agreement', ['venue_manager']],
    ['business_letter', 'General business letter', ['athlete', 'coach', 'referee', 'organizer', 'physio', 'doctor', 'supplier', 'sponsor', 'venue_manager']],
  ].map(([family, label, roles]) => ({ family, label, roles, source: SOURCE(false, 'No canonical source workflow is connected for this document yet, so it cannot be generated.') })),
];

// The constrained document schema a template is stored as. Templates are data, never code: only these block types exist, text is
// plain, and there is no expression, URL or HTML anywhere, so the renderer has nothing executable to run or fetch.
import { z } from 'zod';

export const BLOCKS = ['header', 'title', 'parties', 'lines', 'totals', 'text', 'footer'];
/** Blocks an invoice can never be issued without: a template cannot hide the canonical number, parties, lines or totals. */
export const REQUIRED = { invoice: ['title', 'parties', 'lines', 'totals'], coaching_report: ['title'], season_report: ['title'], sponsorship_agreement: ['title', 'parties', 'lines'], enrolment_letter: ['title'], federation_document: ['title'] };
/** Blocks that mean something for a family; others are refused so a template cannot claim content the document does not have. */
export const ALLOWED = { coaching_report: ['header', 'title', 'text', 'footer'], season_report: ['header', 'title', 'text', 'footer'], enrolment_letter: ['header', 'title', 'text', 'footer'], federation_document: ['header', 'title', 'text', 'footer'], sponsorship_agreement: ['header', 'title', 'parties', 'lines', 'text', 'footer'] };

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

/** A starter layout adapted to a family: blocks that family cannot show are left out, so every starter is valid for every family it is offered for. */
export const starterFor = (family, name) => {
  const s = STARTERS[name] ?? STARTERS.classic;
  const blocks = ALLOWED[family] ? s.blocks.filter((b) => ALLOWED[family].includes(b.type)) : s.blocks;
  // the shared modern starter thanks people "for their business"; a letter to a family says something fitting instead
  const thanks = { enrolment_letter: 'We look forward to seeing you at the academy.', season_report: 'Prepared from the athlete\'s Sportarena records.', federation_document: 'Issued from the federation register.' }[family];
  return thanks ? { ...s, blocks: blocks.map((b) => (b.type === 'text' ? { ...b, text: thanks } : b)) } : { ...s, blocks };
};

/** Parse a layout and make sure the family's mandatory blocks are all present. Returns the parsed layout or throws a message. */
export function checkLayout(family, raw) {
  const r = layoutSchema.safeParse(raw);
  if (!r.success) return { error: r.error.issues.map((i) => `${i.path.join('.') || 'layout'}: ${i.message}`).join('; ') };
  const notAllowed = ALLOWED[family] ? r.data.blocks.filter((b) => !ALLOWED[family].includes(b.type)).map((b) => b.type) : [];
  if (notAllowed.length) return { error: `A ${family} layout cannot use these blocks: ${[...new Set(notAllowed)].join(', ')}` };
  const missing = (REQUIRED[family] ?? []).filter((t) => !r.data.blocks.some((b) => b.type === t));
  if (missing.length) return { error: `A ${family} layout must keep these blocks: ${missing.join(', ')}` };
  return { layout: r.data };
}

const SOURCE = (available, reason) => ({ available, ...(reason ? { reason } : {}) });
/** What each role can produce and whether its canonical source workflow is wired up yet. Invoices, coaching reports and sponsorship agreements are; the rest are listed honestly as not available. */
export const FAMILIES = [
  { family: 'invoice', label: 'Venue invoice / credit note', roles: ['venue_manager', 'athlete', 'organizer', 'coach'], source: SOURCE(true) },
  { family: 'coaching_report', label: 'Coaching progress report', roles: ['coach'], source: SOURCE(true) },
  { family: 'season_report', label: 'Athlete season / career report', roles: ['athlete', 'coach'], source: SOURCE(true) },
  { family: 'sponsorship_agreement', label: 'Sponsorship agreement', roles: ['sponsor', 'athlete', 'organizer'], source: SOURCE(true) },
  { family: 'enrolment_letter', label: 'Academy enrolment letter', roles: ['organizer'], source: SOURCE(true) },
  { family: 'federation_document', label: 'Federation certificate, licence or sanction letter', roles: ['organizer'], source: SOURCE(true) },
  ...[
    ['coaching_plan', 'Training / coaching plan', ['coach']], ['coach_agreement', 'Coaching agreement', ['coach']],
    ['referee_letter', 'Appointment / engagement letter', ['referee']], ['event_timetable', 'Event programme / timetable', ['organizer']],
    ['booking_confirmation', 'Booking confirmation', ['organizer', 'venue_manager']], ['rehab_plan', 'Rehabilitation / exercise plan', ['physio']],
    ['care_plan', 'Approved care plan', ['doctor']], ['purchase_order', 'Purchase order / delivery note', ['supplier']],
    ['hire_agreement', 'Venue hire agreement', ['venue_manager']],
    ['business_letter', 'General business letter', ['athlete', 'coach', 'referee', 'organizer', 'physio', 'doctor', 'supplier', 'sponsor', 'venue_manager']],
  ].map(([family, label, roles]) => ({ family, label, roles, source: SOURCE(false, 'No canonical source workflow is connected for this document yet, so it cannot be generated.') })),
];

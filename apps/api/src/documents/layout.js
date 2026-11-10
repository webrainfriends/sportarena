// The constrained document schema a template is stored as. Templates are data, never code: only these block types exist, text is
// plain, and there is no expression, URL or HTML anywhere, so the renderer has nothing executable to run or fetch.
import { z } from 'zod';

export const BLOCKS = ['header', 'title', 'parties', 'lines', 'totals', 'text', 'footer',
  'activity_table', 'fixture_table', 'booking_block', 'signature_block'];

/** Blocks an invoice can never be issued without: a template cannot hide the canonical number, parties, lines or totals. */
export const REQUIRED = {
  invoice: ['title', 'parties', 'lines', 'totals'],
  coaching_report: ['title'],
  season_report: ['title'],
  sponsorship_agreement: ['title', 'parties', 'lines'],
  enrolment_letter: ['title'],
  federation_document: ['title'],
  academy_progress_report: ['title'],
  academy_management_review: ['title'],
  academy_finance_pack: ['title'],
  academy_term_report: ['title'],
  academy_campus_quality: ['title'],
  coaching_plan: ['title'],
  coach_agreement: ['title', 'parties'],
  referee_letter: ['title'],
  event_timetable: ['title'],
  booking_confirmation: ['title'],
  rehab_plan: ['title'],
  care_plan: ['title'],
  purchase_order: ['title', 'parties', 'lines', 'totals'],
  hire_agreement: ['title', 'parties'],
  business_letter: ['title'],
};

/** Blocks that mean something for a family; others are refused so a template cannot claim content the document does not have. */
export const ALLOWED = {
  coaching_report: ['header', 'title', 'text', 'footer'],
  season_report: ['header', 'title', 'text', 'footer'],
  enrolment_letter: ['header', 'title', 'text', 'footer'],
  federation_document: ['header', 'title', 'text', 'footer'],
  academy_progress_report: ['header', 'title', 'text', 'footer'],
  academy_management_review: ['header', 'title', 'text', 'footer'],
  academy_finance_pack: ['header', 'title', 'text', 'footer'],
  academy_term_report: ['header', 'title', 'text', 'footer'],
  academy_campus_quality: ['header', 'title', 'text', 'footer'],
  sponsorship_agreement: ['header', 'title', 'parties', 'lines', 'text', 'footer'],
  coaching_plan: ['header', 'title', 'activity_table', 'text', 'footer'],
  coach_agreement: ['header', 'title', 'parties', 'text', 'signature_block', 'footer'],
  referee_letter: ['header', 'title', 'parties', 'text', 'signature_block', 'footer'],
  event_timetable: ['header', 'title', 'fixture_table', 'text', 'footer'],
  booking_confirmation: ['header', 'title', 'booking_block', 'text', 'footer'],
  rehab_plan: ['header', 'title', 'activity_table', 'text', 'signature_block', 'footer'],
  care_plan: ['header', 'title', 'text', 'signature_block', 'footer'],
  purchase_order: ['header', 'title', 'parties', 'lines', 'totals', 'text', 'footer'],
  hire_agreement: ['header', 'title', 'parties', 'text', 'signature_block', 'footer'],
  business_letter: ['header', 'title', 'parties', 'text', 'signature_block', 'footer'],
};

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
  const thanks = {
    enrolment_letter: 'We look forward to seeing you at the academy.',
    season_report: 'Prepared from the athlete\'s GotMyGame records.',
    federation_document: 'Issued from the federation register.',
    academy_progress_report: 'Prepared from the athlete\'s academy records.',
    academy_management_review: 'Management view prepared from the academy\'s records.',
    academy_finance_pack: 'Management accounts, not statutory financial statements.',
    academy_term_report: 'Prepared from the academy\'s approved records for this term.',
    academy_campus_quality: 'Management view of one campus, prepared from the academy\'s records.',
    coaching_plan: 'All sessions subject to coach review and athlete progress.',
    coach_agreement: 'Template wording only. Have this reviewed by a qualified professional before signing.',
    referee_letter: 'Issued from the officiating register.',
    event_timetable: 'Schedule subject to change. Check live updates on the day.',
    booking_confirmation: 'Please arrive 10 minutes before your session. Cancellations must be made in advance.',
    rehab_plan: 'This plan is to be followed under the supervision of a qualified physiotherapist.',
    care_plan: 'This plan is issued under medical authority and is to be followed as directed.',
    purchase_order: 'Delivery must match the quantities and specifications listed above.',
    hire_agreement: 'The hirer accepts the terms and conditions of this venue hire agreement.',
    business_letter: '',
  }[family];
  const result = thanks !== undefined ? { ...s, blocks: blocks.map((b) => (b.type === 'text' ? { ...b, text: thanks } : b)) } : { ...s, blocks };
  // For non-text starters, ensure we include the domain-specific block types from ALLOWED
  const domainBlocks = (ALLOWED[family] ?? []).filter((t) => ['activity_table', 'fixture_table', 'booking_block', 'signature_block'].includes(t));
  const hasAll = domainBlocks.every((t) => result.blocks.some((b) => b.type === t));
  if (!hasAll) {
    const toAdd = domainBlocks.filter((t) => !result.blocks.some((b) => b.type === t)).map((type) => ({ type }));
    const footerIdx = result.blocks.findIndex((b) => b.type === 'footer');
    const newBlocks = footerIdx >= 0
      ? [...result.blocks.slice(0, footerIdx), ...toAdd, ...result.blocks.slice(footerIdx)]
      : [...result.blocks, ...toAdd];
    return { ...result, blocks: newBlocks };
  }
  return result;
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
/** What each role can produce and whether its canonical source workflow is wired up yet. */
export const FAMILIES = [
  { family: 'invoice', label: 'Venue invoice / credit note', roles: ['venue_manager', 'athlete', 'organizer', 'coach'], source: SOURCE(true) },
  { family: 'coaching_report', label: 'Coaching progress report', roles: ['coach'], source: SOURCE(true) },
  { family: 'season_report', label: 'Athlete season / career report', roles: ['athlete', 'coach'], source: SOURCE(true) },
  { family: 'sponsorship_agreement', label: 'Sponsorship agreement', roles: ['sponsor', 'athlete', 'organizer'], source: SOURCE(true) },
  { family: 'enrolment_letter', label: 'Academy enrolment letter', roles: ['organizer'], source: SOURCE(true) },
  { family: 'federation_document', label: 'Federation certificate, licence or sanction letter', roles: ['organizer'], source: SOURCE(true) },
  { family: 'academy_progress_report', label: 'Academy athlete progress report', roles: ['organizer'], source: SOURCE(true) },
  { family: 'academy_management_review', label: 'Academy management review', roles: ['organizer'], source: SOURCE(true) },
  { family: 'academy_finance_pack', label: 'Academy finance pack (management accounts)', roles: ['organizer'], source: SOURCE(true) },
  { family: 'academy_term_report', label: 'Academy term report', roles: ['organizer'], source: SOURCE(true) },
  { family: 'academy_campus_quality', label: 'Academy campus quality pack', roles: ['organizer'], source: SOURCE(true) },
  { family: 'coaching_plan', label: 'Training / coaching plan', roles: ['coach'], source: SOURCE(true) },
  { family: 'coach_agreement', label: 'Coaching agreement', roles: ['coach', 'organizer'], source: SOURCE(true) },
  { family: 'referee_letter', label: 'Appointment / engagement letter', roles: ['referee', 'organizer'], source: SOURCE(true) },
  { family: 'event_timetable', label: 'Event programme / timetable', roles: ['organizer'], source: SOURCE(true) },
  { family: 'booking_confirmation', label: 'Booking confirmation', roles: ['organizer', 'venue_manager', 'athlete'], source: SOURCE(true) },
  { family: 'rehab_plan', label: 'Rehabilitation / exercise plan', roles: ['physio'], source: SOURCE(true) },
  { family: 'care_plan', label: 'Approved care plan', roles: ['doctor'], source: SOURCE(true) },
  { family: 'purchase_order', label: 'Purchase order / delivery note', roles: ['supplier', 'organizer'], source: SOURCE(true) },
  { family: 'hire_agreement', label: 'Venue hire agreement', roles: ['venue_manager', 'organizer'], source: SOURCE(true) },
  { family: 'business_letter', label: 'General business letter', roles: ['athlete', 'coach', 'referee', 'organizer', 'physio', 'doctor', 'supplier', 'sponsor', 'venue_manager'], source: SOURCE(true) },
];

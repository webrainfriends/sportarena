// The academy process guide: the single source of truth for the "Process card" on the Organisation / Academy landing page and for the
// PDF download. Each step says what to do, which screen to open, which API modules deliver it (so the guard test notices when a module
// changes with no guide update) and which app screen files its screenshots were taken from (so a changed screen forces new screenshots).
//
// Keep this current: when an organisation, academy, venue, coach, tax or reporting module changes, update the step here, add/adjust the
// English text in apps/app/src/i18n/en.js (+ the other packs), and run `npm run guide:shots` to retake the screenshots. test/process-guide.test.js fails otherwise.
//
// Text lives here in English (the PDF is English-only unless a Unicode font is configured); the app shows the same text through t() keys
// `guide.<id>.title|why|s1..sN`, falling back to this English when a key is missing. test/process-guide.test.js keeps en.js equal to this file.

/** target: where "Open this screen" goes. org = a tab of the organisation workspace; academy = a section of its Academy tab; screen = a pushed route. */
export const ACADEMY_STEPS = [
  {
    id: 'create', title: 'Create your academy',
    why: 'Everything else hangs off the organisation, so start here. You become its owner.',
    steps: ['Open More, then Organisations, and tap Create organisation.', 'Choose Academy as the kind, then enter the name, main sport and currency.', 'Tap Create organisation. Your academy workspace opens with the Academy tab.'],
    target: { screen: 'Orgs' },
    modules: ['organisations.js'], sources: ['apps/app/src/screens/org.js', 'apps/app/src/screens/org-wizard.js'],
  },
  {
    id: 'venues', title: 'Configure venues',
    why: 'Sessions, courts and fees are tied to a venue, so add the places you train before you plan programmes.',
    steps: ['Open the Teams, events & venues tab of your organisation.', 'Add a venue or link one you already manage, then open its workspace.', 'Add courts or pitches and set their sport, then set prices and the weekly timetable.', 'Finish with invoices, tax and contact details so bookings and fees show the right details.', 'Running more than one location? In Academy, Settings, add a branch for each, choose its manager and venues, and place programmes in it so reports can compare locations.'],
    target: { org: 'assets' },
    modules: ['venues.js', 'venue-admin.js', 'venue-facility.js', 'venue-operations.js', 'venue-command.js', 'academy-branches.js'],
    sources: ['apps/app/src/screens/venue-setup.js', 'apps/app/src/screens/venue-workspace.js', 'apps/app/src/screens/academy-closeout.js'],
  },
  {
    id: 'staff', title: 'Add staff',
    why: 'Give coaches, front desk and finance their own access. Each person only sees what their role needs.',
    steps: ['Open the People tab and tap Invite someone, or use Import people to bring a list across.', 'Search for the person and choose their role and department.', 'In Academy, Operations, Staff & leave, set the job title, engagement (employee, contractor or volunteer) and what they can do.', 'They appear under Waiting for a reply until they accept.'],
    target: { org: 'people' },
    modules: ['academy-staff.js', 'academy-payroll.js', 'org-agreements.js'],
    sources: ['apps/app/src/screens/org.js', 'apps/app/src/screens/academy-ops.js'],
  },
  {
    id: 'suppliers', title: 'Add suppliers',
    why: 'Keep maintenance contractors and kit suppliers in one place, linked to the venues they serve, with requests tracked to done.',
    steps: ['Open Academy, then Partners, then Suppliers.', 'Tap the add button, choose the kind (maintenance, sporting goods and so on) and enter the details.', 'Pick one, several or all venues the supplier serves.', 'Use Request on a supplier to ask for a quote or delivery and follow it through to done.', 'When you mark a request delivered or done, enter its final cost and invoice reference: that cost reaches the academy profit and loss once, and the Reconciliation tab reminds you if it is missing.'],
    target: { academy: 'partners' },
    modules: ['academy-suppliers.js'], sources: ['apps/app/src/screens/academy-suppliers.js', 'apps/app/src/screens/academy-partners.js'],
  },
  {
    id: 'programmes', title: 'Build programmes',
    why: 'A programme is what families buy: a squad, a term course or a camp, with a price and places.',
    steps: ['Open Academy, then Programmes, and tap New programme.', 'Work through the steps: sport and venue, schedule, price and places, application questions and agreements.', 'Check the family price preview in Review.', 'Publish to open applications, or save as a draft.', 'After a graduation or squad decision, open the athlete on the Progress page to issue the certificate, send the squad invitation or move them to another cohort.'],
    target: { academy: 'programmes' },
    modules: ['academy-programmes.js', 'academy-pathways.js', 'academy-follow-through.js'], sources: ['apps/app/src/screens/academy-programmes.js'],
  },
  {
    id: 'coaches', title: 'Hire coaches',
    why: 'Bring coaches in as staff, contractors or revenue-share partners, and agree the terms in writing.',
    steps: ['Open the venue workspace and choose your venue.', 'Open its Coaches tab and tap Invite a coach.', 'Search for the coach and choose how they are paid: revenue share, flat fee or staff.', 'For revenue share, set their percentage. The coach can accept or propose an amendment.', 'Once accepted, assign them as lead coach or assistant when you plan classes.'],
    target: { screen: 'VenueWorkspace' },
    modules: ['venue-coaches.js', 'coach-classes.js'], sources: ['apps/app/src/screens/venue-coaches.js', 'apps/app/src/screens/manage.js'],
  },
  {
    id: 'students', title: 'Invite students',
    why: 'Move people from enquiry to enrolled. Parents and guardians consent for children.',
    steps: ['Open Academy, then Admissions.', 'Invite a family to a programme, or review the applications and trials that arrive.', 'Make an offer, then enrol once they accept. Enrolment letters are produced for you.', 'Use Families to see everyone enrolled and who pays.'],
    target: { academy: 'admissions' },
    modules: ['academy-admissions.js', 'academy-trials.js', 'academy-letters.js'], sources: ['apps/app/src/screens/academy-admissions.js', 'apps/app/src/screens/academy-families.js'],
  },
  {
    id: 'scouting', title: 'Scout and recruit talent',
    why: 'Find athletes before they apply: run a scouting campaign with scouts, a committee that votes in the open, and an invitation straight into your admissions, with the source and the guardian\'s consent kept.',
    steps: ['Open Academy, then Scouting, and tap New campaign. Work through the eight steps: brief, player profile, territory, scouting team, evaluation rubric, safeguarding, committee and review. Every step is saved as a draft.', 'Fix anything the review step lists, then launch. Scouts must be verified recruiters linked to your academy; committee members must belong to it.', 'Scouts save athletes they hold access to in their Talent CRM list, add them to the campaign, evaluate them and submit them to the committee.', 'The committee votes (a safeguarding officer can stop an advance for a young person), the chair or an admin records the decision, and you invite the athlete into a programme as a trial or an offer. They appear in Admissions with their source.', 'Open Outcomes for the funnel, conversion, referral sources, regions and scout capacity. Reports show counts only, never names.'],
    target: { academy: 'scouting' },
    modules: ['academy-scouting.js', 'academy-scouting-pipeline.js'], sources: ['apps/app/src/screens/academy-scouting.js', 'apps/app/src/screens/academy-scouting-wizard.js', 'apps/app/src/screens/academy-scouting-entry.js'],
  },
  {
    id: 'development', title: 'Plan athlete development',
    why: 'Give every athlete one season plan that coordinates coaches, conditioning, psychology, school and family, without copying their private records.',
    steps: ['Open Academy, then Progress, then Development plans, and tap New plan for an enrolled athlete.', 'Name the accountable lead, the season dates and the pathway it serves, then add the specialists who work on it.', 'Add objectives with the guided builder: pick the domain and the sport-specific competency, check the athlete\'s current figure and the anonymised peer benchmark, set the target, and tick the usual tasks.', 'Set the season phases (pre-season, competition, exams, recovery) so clashes are flagged, then activate the plan.', 'Run a review each cycle: specialists add their view, the lead signs off and can share it with the athlete and guardians, who acknowledge it.', 'Use the Squad board to see who needs attention across all six domains, with the reasons spelled out.'],
    target: { academy: 'progress' },
    modules: ['academy-dev-plan.js'], sources: ['apps/app/src/screens/academy-dev-plan.js', 'apps/app/src/screens/academy-dev-builder.js', 'apps/app/src/screens/dev-plan-trend.js'],
  },
  {
    id: 'classes', title: 'Track classes',
    why: 'See today and the week at a glance, take attendance and keep make-ups and cancellations visible.',
    steps: ['Open Academy, then Operations.', 'Use Week to build the term timetable: group, term dates, weekdays, start time and lead coach.', 'Use Today to open a session and mark attendance.', 'Use Insights for attendance and delivery trends.'],
    target: { academy: 'ops' },
    modules: ['academy-sessions.js', 'academy-attendance.js', 'academy-ops-board.js', 'academy-desk.js'], sources: ['apps/app/src/screens/academy-ops.js'],
  },
  {
    id: 'tax', title: 'Set up taxation',
    why: 'Know the tax collected and paid, with your own tax rules and tax details on invoices.',
    steps: ['Open Finance and choose the Tax tab (finance access is required).', 'Add your tax registration and tax rules.', 'Read collected, paid and net tax by period and rate.', 'Tax figures are informational, not tax advice.'],
    target: { screen: 'Finance' },
    modules: ['gst.js', 'provider-tax.js', 'academy-billing.js'], sources: ['apps/app/src/screens/finance-tax.js'],
  },
  {
    id: 'revenue', title: 'Share revenue',
    why: 'Agree how money is shared with coaches and how shared costs are spread across programmes.',
    steps: ['For coaches: in the venue workspace, Coaches tab, choose Revenue share as the pay model and set the percentage.', 'For shared costs: in Academy, Finance, open Costs, add a cost and choose how it is spread (participants, revenue share or evenly).', 'Open Profit & loss to review the result per programme, branch and cohort; staff cost is read from approved payroll, venue cost from confirmed bookings, supplier cost from delivered supplier requests and payment fees from the Finance ledger.', 'Open Reconciliation: it lists every cost or charge with no programme and records that could be counted twice; decide each one with a reason.', 'Before adding a cohort or promoting athletes, open Forecast and choose New capacity scenario: pick the period, programme changes, promotions, venue, days, times and coaches. It shows real venue, coach and School timetable conflicts, coaches and hours needed, pathway bottlenecks and cost, and lists what is missing. It changes nothing; you decide on each recommendation.'],
    target: { academy: 'billing' },
    modules: ['academy-finance.js', 'academy-payroll.js', 'academy-reconciliation.js', 'academy-capacity.js'], sources: ['apps/app/src/screens/academy-books.js', 'apps/app/src/screens/academy-reconciliation.js', 'apps/app/src/screens/academy-capacity.js'],
  },
  {
    id: 'reports', title: 'Read reports',
    why: 'See outcomes, retention, finance health and partners on the executive home, and export what you need.',
    steps: ['Open Academy, then Home for the executive view.', 'Check the funnel, fees, outcomes and retention indicators.', 'Open Finance to export the profit and loss.', 'Open Finance, then Overview, for the monthly trend, the cost mix and the branch comparison, and issue the finance pack or management review as a PDF.', 'Open an athlete on the Progress page to issue their progress report as a PDF.', 'Share season reports and shared reports with families or partners.'],
    target: { academy: 'home' },
    modules: ['academy-executive.js', 'academy-athlete360.js', 'org-command-centre.js', 'academy-insights.js', 'academy-packs.js'], sources: ['apps/app/src/screens/academy-home.js', 'apps/app/src/screens/academy-executive.js', 'apps/app/src/screens/academy-overview.js', 'apps/app/src/screens/academy-elite.js'],
  },
  {
    id: 'academics', title: 'Connect schools and studies',
    why: 'Sport-plus-study academies run on both calendars. Link each athlete to their school, let the athlete or guardian choose what to share, and clashes appear before a session is published.',
    steps: ['Open Academy, then Academics, and tap Link an athlete to a school. Pick the athlete and the school already on the platform.', 'The athlete, or a minor\u2019s guardian, is asked what to share (timetable, attendance, progress), with whom and for how long. Nothing is shared until they decide.', 'The school adds exams, lesson blocks and attendance summaries, or sends them by file or API. A school exam that clashes with a session is flagged and blocks publishing.', 'Open an athlete to see sport progress and academic progress side by side as separate blocks, each with its source. Grades are only read with the academics_detail permission and the athlete\u2019s consent.'],
    target: { academy: 'academics' },
    modules: ['academy-academics.js', 'academy-attainment.js'], sources: ['apps/app/src/screens/academics.js'],
  },
  {
    id: 'competition', title: 'Plan competitions and squads',
    why: 'Connect your teams to real fixtures and tournaments, check clashes with training, staff, venues, school exams and travel consent, and publish squads through the Team once your selection committee approves.',
    steps: ['Open Academy, then Competition & Squads, and tap New season plan. Give it a name and the season dates.', 'Tap Link a squad to an event or match. Pick the team, the match or event it plays in, the cohort that trains it and, if there is one, the trip. Teams, fixtures and trips are entered elsewhere (the event console and Trips); this only links them.', 'Work through the readiness checklist, set the selection committee and the participation objectives. Training, staff, venue, school-exam and guardian-consent clashes are listed before you publish.', 'Once the committee has approved and no blocking clash remains, tap Publish squad. People are invited through the Team, and the Participation tab then shows matches and minutes from the official records, never a ranking.'],
    target: { academy: 'competition' },
    modules: ['academy-competition.js'], sources: ['apps/app/src/screens/academy-competition.js', 'apps/app/src/screens/academy-plan-strip.js'],
  },
  {
    id: 'campuses', title: 'Organise campuses and transfers',
    why: 'Run more than one location as one academy: regions, campuses and sport departments, directors with their own view, shared policies, and transfers that follow your own approval process.',
    steps: ['Open the Campuses tab and tap Set up campuses to make your academy one campus without changing any record, or add a region and a campus yourself.', 'Place venues, teams, cohorts, programmes and coaches on a campus or sport department. Each keeps its identity and history; only a dated pointer is added.', 'Give each campus a director, finance, sports lead, operations or auditor role, and set policies that its sport departments inherit.', 'Under Transfers, configure your process (approvals, finance clearance, athlete or guardian acknowledgement, handover checklist), then move athletes, coaches or programmes between campuses with a request that follows it.'],
    target: { org: 'campuses' },
    modules: ['org-campuses.js', 'org-campus-transfers.js'], sources: ['apps/app/src/screens/campuses.js', 'apps/app/src/screens/campus-transfers.js'],
  },
  {
    id: 'safety', title: 'Run pickup and daily safety',
    why: 'Know who arrived, who is in your care and who took each young athlete home. Guardians decide who may collect, staff hand over with checks, and late pickups and no-shows escalate on your timings.',
    steps: ['Open Academy, then Safety & pickup, then Settings, and set when guardians, the second guardian with emergency contacts, and the safeguarding officer are alerted.', 'Ask families to open Family & guardians, then Pickup & safety, to list who may collect, with days, times, a passphrase and emergency contacts.', 'On session day, open the session and its Pickup & handover tab. Check the collector by QR, passphrase or ID, then tap Confirm handover. The guardian confirms on their phone, and the athlete stays in your care until they do.', 'Follow late pickups, no-shows and concerns under Safety & pickup. Details are shown only to staff with the safeguarding permission, and every read is audit-logged.'],
    target: { academy: 'safety' },
    modules: ['academy-pickup.js'], sources: ['apps/app/src/screens/academy-safety.js'],
  },
  {
    id: 'kit', title: 'Issue uniforms and kit',
    why: 'Give every programme, group and squad the kit it is owed, in the right size, and keep stock, deposits and reorders in one place instead of a spreadsheet.',
    steps: ['Open Academy, then Kit, then Stock, and add each product with its sizes, barcode and opening quantity at the venue that holds it.', 'Open Entitlements and say what each programme, group or squad is owed: included in the fee, charged on top, or loaned against a refundable deposit, and when it is due.', 'Open Issue & return, record each athlete\'s size, then hand the kit over (scan its barcode or serial number on a phone, or type it at the desk). A fee or deposit is raised on the family\'s account and the receipt can be shared.', 'Take kit back, exchange sizes, and report damaged or lost kit: a manager approves it under Approvals before anything is written off or a deposit is kept.', 'Open Replenishment to see what is short by size and order it from your supplier. Parents and athletes see their own kit, where to collect it and their receipts under My academy.'],
    target: { academy: 'kit' },
    modules: ['academy-kit.js'], sources: ['apps/app/src/screens/academy-kit.js', 'apps/app/src/screens/academy-kit-desk.js'],
  },
  {
id: 'wellbeing', title: 'Support student wellbeing and development',
    why: 'Offer mentoring, check-ins, development goals and optional tracks with the family\'s consent, and see what is due without ever seeing what was said.',
    steps: ['Open Academy, then Wellbeing, then Tracks, and create optional tracks in values, leadership, life skills, nutrition education or study skills, with an age band and ordered modules.', 'In Staff & leave, give mentors the Mentor template (the wellbeing permission). Then open People, ask families for their choices, and assign a mentor once the family has chosen mentoring.', 'Mentors schedule check-ins from People, record what was agreed (never what was said) and close follow-ups. A concern goes privately to safeguarding staff, and counselling or clinical wording is refused in notes.', 'Families see their choices, mentor, check-ins, goals and who has opened the record under My academy, then Wellbeing, and can withdraw any choice at any time. Overview shows what is due and participation counts, never content or a score about a person.'],
    target: { academy: 'wellbeing' },
    modules: ['academy-wellbeing.js', 'academy-wellbeing-family.js', 'academy-wellbeing-overview.js'], sources: ['apps/app/src/screens/academy-wellbeing.js', 'apps/app/src/screens/academy-wellbeing-tracks.js', 'apps/app/src/screens/wellbeing-family.js'],
  },
];

/** Org/academy API modules with no step of their own, and why. Anything not here and not in a step fails the guard test. */
export const NOT_IN_GUIDE = {
  'academy-curriculum.js': 'Curriculum, methodology and coaching-philosophy governance is set up by the academy after the first setup; it is described in docs/academy-curriculum.md, not in this onboarding guide.',
};

/** The directories/files the guard test watches for org/academy/venue/coach/tax capability modules. */
export const WATCHED_MODULES = /^(academy-.*|org-.*|organisations|venue-coaches|gst|provider-tax|coach-classes)\.js$/;

export const SHOT_SIZES = { phone: { width: 390, height: 1100 }, desktop: { width: 1280, height: 900 } };
export const shotFile = (stepId, size) => `${String(ACADEMY_STEPS.findIndex((s) => s.id === stepId) + 1).padStart(2, '0')}-${stepId}-${size}.png`;
export const GUIDE_PERSONAS = { academy: ACADEMY_STEPS };

// ---- freshness: a hash of the app screens each step's screenshots were taken from. `npm run guide:shots` records it in assets/guides/<persona>/manifest.json
// and test/process-guide.test.js fails when a screen changed without the screenshots being retaken.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const sourcesHash = (step) => crypto.createHash('sha256').update(step.sources.map((f) => `${f}\n${fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\r\n/g, '\n')}`).join('\n--\n')).digest('hex').slice(0, 16);
export const MANIFEST_FILE = path.join(REPO_ROOT, 'apps/api/assets/guides/academy/manifest.json');

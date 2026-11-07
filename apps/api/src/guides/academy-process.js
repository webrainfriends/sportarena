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
    steps: ['Open the Teams, events & venues tab of your organisation.', 'Add a venue or link one you already manage, then open its workspace. If the venue already exists as an unclaimed listing, tap Claim This Venue, choose your role (Owner, Manager, or Authorised Agent), upload at least two ownership documents (title deed, trade licence, ID proof, authorisation letter), write a brief statement and submit. Platform staff review within 2 business days and may contact you to verify documents. If two people claim the same venue, the platform team resolves the conflict and auto-rejects the other claim on approval; the rejected party may dispute once with additional evidence.', 'To bring a large portfolio of venues onto the platform at once, open Venue workspace, tap Import venues, choose your source (Playo, GotSport, TeamSnap, SportsEngine or any CSV/Excel file), and work through the 5-step wizard: upload → map columns (auto-detected for Playo/GotSport exports) → dry-run preview with row-level error hints and paisa-precise rate validation → conflict review per duplicate row → confirm and run. The import is fully reversible within 48 hours: a Rollback button pauses the imported venues without deleting any data.', 'Once your venue is live and has an accepted partner contract, open Partners, then the venue\'s contract, and configure a Settlement Schedule: choose weekly, biweekly or monthly, set a tolerance for auto-approval, and enable auto-approve when reconciled. The platform then generates, reconciles and pays out settlements automatically on schedule. Each statement shows gross bookings, refunds, platform commission, GST, TDS and net payout, reconciled to the paisa against canonical payment records. Failed bank transfers surface in the platform admin Failed Payouts queue where staff can retry, request updated bank details, or override the payout account.', 'Add courts or pitches and set their sport, then set prices and the weekly timetable. Use the bulk slots wizard (4 steps: Courts & Days → Pricing & Type → Rules & Access → Para-Sport) to open many courts at once, set booking types (public, members, academy class, private coaching, group, event reserved), booking rules (advance booking windows, buffer time, member limits, age restrictions, cancellation policy) and para-sport accessibility flags per slot.', 'Finish with invoices, tax and contact details so bookings and fees show the right details.', 'Running more than one location? In Academy, Settings, add a branch for each, choose its manager and venues, and place programmes in it so reports can compare locations.', 'Open the venue workspace and tap the Compliance Register tab. The register covers ten categories: Operating, Safety, Sports Grade, Food & Beverage, Health & Medical, Environmental, Finance & Tax, Employment, Events, and Other. For each item choose its category, then pick or type the specific licence or permit type (e.g. ITF Court Certification, FIFA Pitch Licence, BWF Court Grade, fire safety certificate, food hygiene permit). Enter the issuing authority, country and region, the reference number (stored encrypted), and the issue and expiry dates. Assign a responsible person who will own the renewal workflow and receive all alerts. Set reminder points — default 90, 60, 30, 14, 7 and 1 day before expiry — and choose the renewal stage (Not started → Applied → In review → Issued). Optionally store the annual fee and a renewal cost estimate so the register becomes a live regulatory budget. The score ring on the register header shows a grade from Excellent (≥90 %) to At Risk (<50 %), with a 12-month expiry forecast broken down by category, so a head coach or compliance officer can see the academy\'s regulatory standing at a glance and act before any permit lapses.',      'Open the venue workspace and tap the Plans tab to build membership and access products using the elite plans wizard. Four product types are supported — Membership (recurring by week, month or year), Subscription (calendar-period auto-renewing), Pass (session bundle), and Package (court-time bundle) — each guided by a 4–5 step workflow. Step 1 – Identity: assign a tier (Bronze → Silver → Gold → Platinum → Elite) with an emoji badge and tagline, optionally restrict to specific sports or courts, and set a capacity cap that stops new sales once N active holders is reached. Step 2 – Pricing: set the recurring price (or sessions/hours count for passes/packages), add an optional joining fee, choose a loyalty discount percentage, and configure an early-bird intro price active for a set number of days after the plan goes on sale. Step 3 – Access: set allowed weekdays and entry window, booking priority lead-time (how many hours before non-members), and guest entitlements. Step 4 – Perks: pick from the professional catalogue (Locker, Video analysis, Physio access, Nutrition consult, Recovery room, Strength & conditioning, Court towel service, Parking, Laundry service, and more), set included coaching hours per period, and toggle auto-renew. Final step – Review: check the live plan preview card showing tier badge, pricing, perk chips, coaching hours and sport restrictions, add a free-text description and internal staff notes, then publish. The Plans console stat strip shows total revenue, active holders, sessions consumed, and plans currently on sale at a glance.'],
    target: { org: 'assets' },
    modules: ['venues.js', 'venue-admin.js', 'venue-facility.js', 'venue-operations.js', 'venue-command.js', 'venue-claims.js', 'venue-import.js', 'settlement-schedules.js', 'academy-branches.js', 'plans.js'],
    sources: ['apps/app/src/screens/venue-setup.js', 'apps/app/src/screens/venue-workspace.js', 'apps/app/src/screens/venue-compliance.js', 'apps/app/src/screens/venue-claim.js', 'apps/app/src/screens/venue-import.js', 'apps/app/src/screens/settlement-runs.js', 'apps/app/src/screens/academy-closeout.js', 'apps/app/src/screens/plans.js'],
  },
  {
    id: 'staff', title: 'Add staff',
    why: 'Give coaches, front desk and finance their own access. Each person only sees what their role needs.',
    steps: ['Open the People tab and tap Invite someone, or use Import people to bring a list across.', 'Search for the person and choose their role and department.', 'In Academy, Operations, Staff & leave, set the job title, engagement (employee, contractor or volunteer) and what they can do.', 'They appear under Waiting for a reply until they accept.', 'Coaches who list themselves for adaptive coaching show their credential state (verified, self-declared, expired or revoked) on the staff list, so you can check instructors before assigning para sessions. It is a coaching credential only, never medical authorisation or a classification.'],
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
    steps: ['Open Academy, then Programmes, and tap New programme.', 'Work through the steps: sport and venue, schedule, price and places, application questions and agreements. Para and adaptive sports are in the same sport list: tap the Para & adaptive filter to find them.', 'Check the family price preview in Review.', 'Publish to open applications, or save as a draft.', 'After a graduation or squad decision, open the athlete on the Progress page to issue the certificate, send the squad invitation or move them to another cohort.'],
    target: { academy: 'programmes' },
    modules: ['academy-programmes.js', 'academy-pathways.js', 'academy-follow-through.js'], sources: ['apps/app/src/screens/academy-programmes.js'],
  },
  {
    id: 'coaches', title: 'Hire coaches',
    why: 'Bring coaches in as staff, contractors or revenue-share partners, and agree the terms in writing through the elite 4-step contract wizard.',
    steps: [
      'Open the venue workspace and choose your venue.',
      'Open its Coaches tab and tap Invite a coach.',
      'Step 1 — Profile & Role: search for the coach, choose their engagement type (staff, independent, visiting specialist, master clinician), select sports, session format (1-on-1, small group, group, squad), age groups, performance levels, and set daily session and student limits.',
      'Step 2 — Contract & Pay: set the contract type, start and end date, probation and notice period, pay model (revenue share with percentage, flat fee, or staff salary), bonus model and trigger, and compliance switches (kit provided, equipment allocated, non-compete, media consent).',
      'Step 3 — KPIs & Review: review market-rate intelligence (platform median and quartiles for your region and sport), set the review frequency, and choose performance targets — retention rate, minimum feedback score and target ranking lift.',
      'Step 4 — Para-Sport: record the coach\'s classification awareness, adaptive coaching experience, communication adaptations, guide-role capability and adaptive-equipment training. This is coaching and operational data only — no classification codes or medical information is stored.',
      'Send the proposal. The coach can accept, amend terms, or reject. Once agreed, assign them as lead coach or assistant when you plan classes.',
      'For para sport sessions, pick a para-adapted template from the Template picker in the session editor — tap the Para sport filter chip to browse them.',
    ],
    target: { screen: 'VenueWorkspace' },
    modules: ['venue-coaches.js', 'coach-classes.js', 'coaching-para.js'], sources: ['apps/app/src/screens/venue-coaches.js', 'apps/app/src/screens/manage.js', 'apps/app/src/screens/coaching-para.js'],
  },
  {
    id: 'inclusive_delivery',
    title: 'Inclusive programme delivery',
    why: 'Connect accommodations, qualified coaches and accessible venues before each session, so every athlete trains safely and the right support is in place before the first whistle.',
    steps: [
      'Open Academy, then Inclusion to configure which need types a programme supports and what venue features are required.',
      'After enrolling an athlete, the enrolment flow prompts guardians or the athlete to share their operational needs with the coaching team.',
      'Open any upcoming session to see the Inclusion Readiness panel: requirements are marked met, short or gap so you can act before the session.',
      'If an athlete changes programme, use Change programme in Inclusion to carry their accommodation shares to the new team, revoke access for coaches who leave and prompt re-share where needed.',
      'Guardians open the Guardian progress view under Inclusion to see attendance, adapted assessment milestones and upcoming sessions without seeing the coaching team\'s operational notes.',
    ],
    target: { academy: 'inclusion' },
    modules: ['academy-inclusion.js', 'academy-sessions.js', 'coach-adaptive.js', 'para-learn.js'],
    sources: ['apps/app/src/screens/academy-inclusion.js', 'apps/app/src/screens/academy-session.js', 'apps/app/src/screens/academy-admissions.js', 'apps/app/src/screens/para-learn.js'],
  },
  {
    id: 'para_learn',
    title: 'Adaptive sport learning paths',
    why: 'Give athletes structured, editorially reviewed content for every para sport — from first steps to competition-ready — with automatic badge issuance when a path is completed.',
    steps: [
      'Open More, then Learn & Study sport, then the Adaptive sport tab.',
      'Select a sport and choose a level (Beginner, Intermediate or Advanced) to browse published paths. Each path shows its modules, estimated time and source attribution.',
      'Open a module to read its content, follow accessible media links (captions, transcript, audio description) and answer the check question.',
      'On completing all required modules in a path, a badge is issued automatically and appears in the Badges tab.',
      'Platform team: open the Publishing panel (visible to admins in the Adaptive sport tab) to draft a new path, add modules with accessible media metadata, submit for review, approve and publish. Source and copyright attribution are required before submission.',
      'Approved institutions: request publishing access from the platform admin. Submitted content is reviewed before it goes live. Institution access is managed in More → Learn & Study → Adaptive sport → Publishing.',
    ],
    target: { screen: 'Pathways' },
    modules: ['para-learn.js'],
    sources: ['apps/app/src/screens/para-learn.js', 'apps/app/src/screens/pathways.js'],
  },
  {
    id: 'consented_accommodations',
    title: 'Athlete-consented accommodations and preferences',
    why: 'Athletes and guardians control exactly who sees their operational support needs, for which sessions and for how long. Staff see only what they need; the athlete sees every access in their history.',
    steps: [
      'Open your Academy profile, then Support preferences to view, add or revise your operational accommodation shares. Each share states the audience (coaching team, venue, event staff), the context (academy-wide or one event) and the purpose.',
      'To link a share to a specific event or competition day, tap the Event context toggle and choose the event. The share expires when the event ends and is never shown to other staff.',
      'Open Accessible contact & arrival preferences to set how staff reach you at the venue: preferred contact mode (app notification, email, SMS or BSL interpreter), an alternative contact, your arrival instructions and the best entry point. These preferences are encrypted and shown only to staff whose share includes a communication need.',
      'On session day, coaching and event staff open the session, then the Support checklist button, to see the per-athlete needs they are responsible for arranging. Tick each need as arranged and add a brief arrangement note; a progress bar shows readiness at a glance. No diagnosis or clinical detail is ever shown.',
      'Athletes and guardians open Support history to review every access event: who viewed a share, when and why. Use Request a correction if a record is wrong, or Export my data for a full DSAR download.',
    ],
    target: { screen: 'SupportPreferences' },
    modules: ['academy-inclusion.js', 'accommodations-ps03.js'],
    sources: [
      'apps/app/src/screens/support-preferences.js',
      'apps/app/src/screens/accessible-contact-preferences.js',
      'apps/app/src/screens/accommodation-checklist.js',
      'apps/app/src/screens/accommodation-history.js',
      'apps/app/src/screens/academy-session.js',
    ],
  },
  {
    id: 'students', title: 'Invite students',
    why: 'Move people from enquiry to enrolled. Parents and guardians consent for children.',
    steps: ['Open Academy, then Admissions.', 'Invite a family to a programme, or review the applications and trials that arrive.', 'Make an offer, then enrol once they accept. Enrolment letters are produced for you.', 'For an athlete joining from abroad, open Start international checklist on the application, then track permissions, passport and visa status, school, residence and arrival under International. Enrolment waits until every mandatory item is met.', 'Use Families to see everyone enrolled and who pays.', 'For younger students without their own account, the guardian opens Family & guardians, taps Add a child and completes the six-step profile (name, date of birth, sports, medical card, kit sizes, biometrics). The managed child profile is linked immediately — no separate enrolment step. The guardian can then invite a co-parent or co-guardian from the same screen to co-manage multiple children in one action.'],
    target: { academy: 'admissions' },
    modules: ['academy-admissions.js', 'academy-trials.js', 'academy-letters.js', 'academy-international.js', 'guardian-onboarding.js'], sources: ['apps/app/src/screens/academy-admissions.js', 'apps/app/src/screens/academy-families.js', 'apps/app/src/screens/academy-international.js', 'apps/app/src/screens/guardian-onboarding.js'],
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
    steps: ['Open Academy, then Progress, then Development plans, and tap New plan for an enrolled athlete.', 'Name the accountable lead, the season dates and the pathway it serves, then add the specialists who work on it.', 'Add objectives with the guided builder: pick the domain and the sport-specific competency, check the athlete\'s current figure and the anonymised peer benchmark, set the target, and tick the usual tasks.', 'Set the season phases (pre-season, competition, exams, recovery) so clashes are flagged, then activate the plan.', 'Run a review each cycle: specialists add their view, the lead signs off and can share it with the athlete and guardians, who acknowledge it.', 'Use the Squad board to see who needs attention across all six domains, with the reasons spelled out.', 'Review technique with video: open a session, then the Video tab, and link a clip the athlete has shared, add timed annotations, and create the shared development action it belongs to. Athletes and guardians reply from their Progress tab; Progress, then Video feedback, lists every reply. Viewing stops at once if sharing is revoked or guardian media consent is withdrawn.', 'Carry a promotion, squad transfer or graduation through: record the decision in the review queue, open the athlete, tap Plan promotion and choose the new group, squad or certificate. The pre-flight checks capacity, age band, consent and unpaid fees; a person approves; the system moves the group and invites the squad, and the athlete or guardian answers. A graduation issues the certificate only after a final approval. Follow every run under Progress, then Promotions; a failed step can be retried or rolled back with the history kept.'],
    target: { academy: 'progress' },
    modules: ['academy-dev-plan.js', 'academy-video.js', 'academy-promotions.js'], sources: ['apps/app/src/screens/academy-dev-plan.js', 'apps/app/src/screens/academy-video.js', 'apps/app/src/screens/academy-dev-builder.js', 'apps/app/src/screens/dev-plan-trend.js', 'apps/app/src/screens/academy-promotions.js'],
  },
  {
    id: 'content', title: 'License your curriculum',
    why: 'Package your approved methodology, curricula, drills and micro-courses as a licensed pack, so affiliated and independent organisations can buy seats for their coaches while you keep the rights, the versions and the revenue record.',
    steps: ['Open Academy, then Content, then Packs, and tap New pack. Choose the sport, level, ages and languages, credit the authors, and set who may license it (open, affiliated or by invitation), the territory, the seat limit and whether offline copies are allowed.', 'Add items: pick your published curriculum versions, methodology versions and approved drills (they are linked, never copied), then add micro-courses and video references. Mark footage that shows young people: it is stream-only, watermarked and never offline.', 'State the learning objectives, assessment and coach development hours, set the price per seat, the term, the grace period and the revenue split, then publish. A published version never changes.', 'When an organisation requests a pack, open Licences granted, set the terms (seats, dates, version, price) and send the offer. The buyer accepts and pays through the normal checkout, then assigns seats to its coaches. A coach then opens a session, goes to its Curriculum tab, links licensed items under Licensed content and adds them to their own coaching plan.', 'Watch Overview and a pack’s Usage and Money tabs for seats, completion, renewals due and the revenue statement. Suspend, revoke or renew a licence with a reason: access ends at once and the buyer\'s own academy data is untouched. Handle support and takedown cases under Support & takedowns.'],
    target: { academy: 'content' },
    modules: ['academy-content.js'], sources: ['apps/app/src/screens/academy-content.js', 'apps/app/src/screens/academy-content-pack.js'],
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
    steps: ['Open Academy, then Academics, and tap Link an athlete to a school. Pick the athlete and the school already on the platform.', 'The athlete, or a minor’s guardian, is asked what to share (timetable, attendance, progress), with whom and for how long. Nothing is shared until they decide.', 'The school adds exams, lesson blocks and attendance summaries, or sends them by file or API. A school exam that clashes with a session is flagged and blocks publishing.', 'Open an athlete to see sport progress and academic progress side by side as separate blocks, each with its source. Grades are only read with the academics_detail permission and the athlete\'s consent.'],
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
    steps: ['Open Academy, then Safety & pickup, then Settings, and set when guardians, the second guardian with emergency contacts, and the safeguarding officer are alerted.', 'Ask families to open Family & guardians, then Pickup & safety, to list who may collect, with days, times, a passphrase and emergency contacts.', 'On session day, open the session and its Pickup & handover tab. Check the collector by QR, passphrase or ID, then tap Confirm handover. The guardian confirms on their phone, and the athlete stays in your care until they do.', 'Follow late pickups, no-shows and concerns under Safety & pickup. Details are shown only to staff with the safeguarding permission, and every read is audit-logged.', 'Families can share the journey too: guardians open Family & guardians, then Carpool, to browse or offer rides to the event. Drivers share only an area label until a match is confirmed; exact addresses are exchanged privately after both sides agree. Academy staff do not co-ordinate carpool — that is a family-to-family arrangement.', 'For events that need on-site help, academy staff open the event console, then Volunteers, to publish shifts. Guardians see open positions on their Family & guardians home and sign up directly. Volunteer hours are tracked automatically.'],
    target: { academy: 'safety' },
    modules: ['academy-pickup.js', 'academy-transport.js', 'carpool.js', 'volunteers.js', 'trips-access.js'], sources: ['apps/app/src/screens/academy-safety.js', 'apps/app/src/screens/academy-transport-board.js', 'apps/app/src/screens/academy-transport.js', 'apps/app/src/screens/carpool.js', 'apps/app/src/screens/team-volunteers.js'],
    para_step: 'Para accessibility — before a delegation departs, open Academy → Transport → Para tab, record wheelchair spaces, hoist, securement points and hearing loop for each vehicle, then ask athletes (or their guardians) to open Travel → Access on the trip to declare their consented access needs. Trip managers recheck suitability from the Trip → ♿ Access tab and resolve any WAV capacity gaps or alerts before departure.',
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
  {
    id: 'inclusion', title: 'Run inclusive and adaptive programmes',
    why: 'Let disabled and para athletes join and progress in your programmes without disclosing a diagnosis: set what a programme offers, check every adaptive session is ready, and let athletes share only the operational needs they choose.',
    steps: ['Open Academy, then Inclusion, then Programme setup, pick a programme and choose who can join, the sport adaptation templates, the adjustments offered, the venue features and the support-person ratio it needs.', 'Ask venue managers to open the venue Accessibility audit (Venue → Accessibility) and record all 13 access features — lift, step-free route, accessible changing rooms, pool hoist and more — with verification metadata: choose Certified, Third-party verified, Self-reported or Provisional, name the assessor, attach an evidence reference and set an expiry date. Certified and third-party records carry the most weight when athletes filter discovery.', 'When a feature becomes temporarily unavailable, raise an outage from the Accessibility audit screen. Everyone with a confirmed booking at the venue in the next 90 days is notified automatically. Mark it restored when it is back.', 'Athletes and bookers can filter the venue discovery screen by any combination of the 13 access features and choose the minimum confidence level (self-reported or better, third-party or better, certified only). Venue cards show the accessibility state badges.', 'Athletes, or the verified guardian of a young person, open My academy, then Accommodations, and share only what staff need, with whom and until when. They can withdraw it at any moment.', 'Open Inclusion, then Session readiness, choose a session and resolve every gap: venue, support persons, duty cover and the lead coach credential. The booking access-suitability checklist shows each required feature with its current state (Met / Outage / Unknown / Expired). Coaches and venue staff see only what was shared with them, and every look is logged for the athlete.', 'Record adapted, coach-led assessments with descriptor levels, never a single score, and have a second assessor sign them off. Directors see counts only on the Overview.', 'Open Academy, then Inclusion, then Para pathways, to see which enrolled athletes have shared their athlete-owned para-sport pathway with you. View their milestones and evidence for the stages they granted you, and leave feedback on a checkpoint when asked. The athlete controls what you can see and can revoke access at any moment.', 'Before opening any para-sport event, complete the accessibility readiness gate: open the event console, tap the Para Readiness tab, tap Add Standard Items to import the full accessibility checklist (accessible entrance, adapted facilities, classification, support roles, medical station, evacuation plan, equipment, transport and communication), and sign off each item with an evidence reference (booking ID, staff assignment, supplier contract). Safety-critical items (medical station and evacuation plan) block the event from opening until met or a second-officer-approved documented exception is in place. Document unavoidable exceptions with a justification and evidence; safety-critical exceptions require a named second officer who reviews independently before the exception is activated. Use Send Notification to push role-appropriate accessibility briefings (organiser, venue, official, athlete) with a contingency plan. Accepted para athletes see their confirmed operational access information in the event\'s Accessibility tab — venue details, transport and communication arrangements — without any clinical or classification data.'],
    target: { academy: 'inclusion' },
    modules: ['academy-inclusion.js', 'para-pathway.js', 'para-physio.js', 'para-sport-funding.js', 'venue-accessibility.js', 'para-readiness.js'], sources: ['apps/app/src/screens/academy-inclusion.js', 'apps/app/src/screens/inclusion-family.js', 'apps/app/src/screens/para-pathway.js', 'apps/app/src/screens/physio-para-rehab.js', 'apps/app/src/screens/sponsor-programs.js', 'apps/app/src/screens/player-funding.js', 'apps/app/src/screens/venue-access-audit.js', 'apps/app/src/screens/venue-access-public.js', 'apps/app/src/screens/booking-access-checklist.js', 'apps/app/src/screens/event-access-checklist.js', 'apps/app/src/screens/para-readiness.js'],
  },
  {
    id: 'placement', title: 'Manage placement pathways',
    why: 'Give every graduating athlete a consented bridge from academy progression to university, scholarship and professional opportunities, managed by a placement advisor with an auditable funnel, evidence checklist, reference requests and revocable institution sharing.',
    steps: ['Open Academy, then Placement, and tap Add opportunity for an enrolled athlete.', 'Choose the type (university place, scholarship, grant or professional contract), set the institution, sport, deadline and intake year.', 'Build the evidence checklist: add items for academic transcript, sport CV, performance video, references and any passport or ranking documents.', 'Request references from coaches, academic coordinators or other referees and track their submission status.', 'Ask the athlete (or their guardian for under-18s) to grant the institution access to specific evidence fields. They choose exactly what to share and can revoke at any time.', 'Advance the opportunity through its stages — identified, eligibility check, evidence gathering, applied, offer received, outcome — as the process progresses.', 'Link a sponsorship award to the opportunity for attribution tracking across the finance module.', 'Use the Action Queue to triage urgent items: references due, missing evidence and pending guardian consents. Use Analytics for seasonal outcome and scholarship reports.'],
    target: { academy: 'placement' },
    modules: ['academy-placement.js'], sources: ['apps/app/src/screens/academy-placement.js'],
  },
  {
    id: 'accreditation', title: 'Manage accreditation and audits',
    why: 'Track every external accreditation, licence and quality mark your academy holds, keep the evidence for each one linked to records you already maintain, and run audits with findings and corrective actions that cannot be quietly changed.',
    steps: ['Open Academy, then Accreditation, and tap Configure to add a framework: the accrediting body, type, level, owner, renewal cycle and reminder lead time.', 'Open the framework, choose Evidence, add what it requires, then link coach credentials and compliance records. Nothing is copied, and validity is read live.', 'Tap Schedule audit, choose the type, date and areas to verify, and optionally name an inspector, who sees that audit only.', 'Record each finding with its severity and corrective actions, give every action an owner and a due date, and mark them done as the work is finished.', 'Resubmit once every high and medium finding is resolved, then record the inspector decision. Every step is kept in a locked trail.'],
    target: { academy: 'accreditation' },
    modules: ['academy-accreditation.js'], sources: ['apps/app/src/screens/academy-accreditation.js'],
  },
  {
    id: 'report_packs', title: 'Issue reviewed report packs',
    why: 'Send families, boards and finance branded PDF packs that a second person has checked and approved, with the data basis and any gaps shown.',
    steps: ['Open Academy, then Reports. Choose a pack: development report, term report, board management pack, P&L pack or campus quality pack.', 'Tap New draft and pick the athlete, campus and period. The figures are frozen when the draft is created and nothing is shared yet.', 'Tap Schedule to have drafts prepared weekly, monthly or each quarter for a group or campus. A schedule only drafts; it never issues.', 'Send the draft to review. A different owner or admin checks the data basis, evidence versions, gaps and who can read it, then approves or asks for changes.', 'Issue the approved pack. Guardians (or the adult athlete) get a notice with no figures and open the PDF securely from My academy.', 'To withdraw a pack, open it and tap Revoke with a reason. The file stops opening at once and the history is kept.'],
    target: { academy: 'reports' },
    modules: ['academy-report-packs.js', 'academy-packs.js'], sources: ['apps/app/src/screens/academy-reports.js'],
  },
  {
    id: 'para_doctor', title: 'Para-athlete clinical coordination',
    why: 'Enable specialist doctors to declare para-sport expertise, structure consultations with sport-specific templates, coordinate referrals to prosthetists and rehabilitation clinicians, and share nonclinical operational summaries with coaches and event staff — entirely separate from classification and always with athlete consent.',
    steps: ['Open Doctor workspace → Adaptive tab. Declare the para-sports you have clinical expertise in; this appears on your profile and is not a classification credential.', 'Create consult templates for each relevant sport: name the template, write a description, and define the structured fields you use each session.', 'When consulting a para-athlete, open their patient file and create a para episode, linking it to the appropriate sport and template.', 'To extend the care pathway, use Health → Referrals to refer to prosthetists, rehabilitation clinicians or sports medicine providers already on the platform.', 'Draft a nonclinical support summary for operational staff (access needs, emergency contacts, general support). The athlete receives a consent request; only after they approve can staff see the summary.', 'Athletes manage consent from Health → Support tab: approve, decline or revoke individual access per person at any time.'],
    target: { health: 'doctor', athlete: 'support' },
    modules: ['para-doctor-consult.js'], sources: ['apps/app/src/screens/doctor.js', 'apps/app/src/screens/health-file.js'],
  },
  {
    id: 'venue_plans', title: 'Set up passes, packages & memberships',
    why: 'Elite academies offer structured access products — memberships that give a percentage off every booking, subscriptions that renew automatically, prepaid session passes, and court-specific packages. Each is created in a 4–5 step wizard covering tier and identity, pricing and early-bird offers, access entitlements (days, times, priority booking window), perks (coaching hours, locker, physio, video analysis, nutrition, recovery, strength & conditioning), and a live-preview review before publishing. All products sell online in the venue currency and feed the Plans Revenue dashboard.',
    steps: [
      'Open the venue workspace and tap Passes, packages & memberships.',
      'Tap + Membership (for a percentage discount off every booking) or + Subscription (same but auto-renewing with payment reminders). Work through the five wizard steps: (1) Identity — choose a tier (Bronze → Elite), name the plan, pick a badge emoji and write a marketing tagline; optionally restrict to one or more sports. (2) Pricing & Duration — set the price, an optional one-time joining fee, the duration (1 m to 2 y), booking discount percentage, and an early-bird intro price valid for a set number of days. (3) Access Entitlements — select the days of the week members may enter, the entry window (e.g. 06:00–22:00), how many hours ahead of the public members can book courts, an optional guest quota, and a capacity cap so the plan stops selling when full. (4) Perks & Benefits — pick from 16 perks (locker, towel, priority, coaching clinic, shower, café discount, equipment hire, free guest pass, court towel service, video analysis, physio access, nutrition consult, recovery room, strength & conditioning, parking, laundry service) and set included coaching hours per period. For subscriptions, enable subscription mode so members receive a one-week renewal reminder. (5) Review & Publish — the live-preview card shows exactly what members see; add a marketing description and internal notes, then tap Publish Membership or Publish Subscription.',
      'Tap + Pass (prepaid sessions) or + Package (court-specific pass). Work through four steps: (1) Identity — choose a tier, name the pass, pick an emoji and tagline; for a package, select which courts it is valid on. (2) Pricing — choose how many sessions (1, 5, 10, 20, 50), set the total price and optionally a maximum value each session may pay toward a booking (defaults to price ÷ sessions). Add an early-bird intro offer if desired. (3) Validity & Policy — set the number of days a pass must be used within after purchase, pick included perks, and optionally cap how many passes may be active at once. (4) Review & Publish — preview the card, add a description and internal notes, then publish.',
      'Once published, plans appear on the venue discovery page. Members buy online; active memberships show a discount badge on booking, and pass sessions are drawn automatically (soonest-expiring first) at checkout.',
      'From the Plans console, tap the ⋯ menu on any plan to Stop selling (hides it from new buyers while existing holders keep their access) or Sell again. The stats strip shows Plan Revenue, Active Holders, Sessions Pending, and Plans on Sale.',
      'Monitor the Renewals waiting for payment panel for subscriptions where the renewal period started but payment is outstanding.',
    ],
    modules: ['plans.js'],
    sources: ['apps/app/src/screens/plans.js'],
  },
];

/** Org/academy API modules with no step of their own, and why. Anything not here and not in a step fails the guard test. */
export const NOT_IN_GUIDE = {
  'academy-curriculum.js': 'Curriculum, methodology and coaching-philosophy governance is set up by the academy after the first setup; it is described in docs/academy-curriculum.md, not in this onboarding guide.',
  'para-performance.js': 'Governed para-sport performance insights and coach review are activated per athlete after classification is confirmed; they extend the athlete hub and coaching module, not the initial academy onboarding sequence.',
  'para-mentoring.js': 'Para peer mentoring is an athlete-facing feature (athletes discover and connect with peer mentors directly), not an org-onboarding step. It is not part of setting up an academy.',
  'platform-benchmarks.js': 'Platform Competitive Benchmarks is a platform-admin-only console (not an academy-onboarding step). It is documented in docs/platform-benchmarks.md.',
};

/** The directories/files the guard test watches for org/academy/venue/coach/tax capability modules. */
export const WATCHED_MODULES = /^(academy-.*|org-.*|organisations|venue-coaches|gst|provider-tax|coach-classes|para-sport-funding|para-pathway|para-readiness|para-learn)\.js$/;

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

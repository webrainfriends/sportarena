// Standard sports agreement templates. These are starting points that an organisation tailors (edit the text, ask AI to adapt it, change
// parties, dates and fees) before submitting for approval. They are general wording and not legal advice; the generated PDF says so.
// `publish` marks templates whose approved text is also published as an organisation policy that families or members acknowledge.

const ORG = 'the Organisation';

export const AGREEMENT_TEMPLATES = [
  {
    key: 'participation', kind: 'participation', title: 'Participation terms', other: 'Participant', publish: 'participation',
    summary: 'Terms for taking part in programmes, sessions or training run by the organisation.',
    clauses: [
      ['Participation', 'The Participant may take part in the activities offered by the Organisation for the period stated in this agreement, subject to these terms and to any safety instructions given by coaches or staff.'],
      ['Health and fitness', 'The Participant (or their parent or guardian) confirms that they are fit to take part, will tell the Organisation about any condition that may affect safe participation, and will keep that information up to date.'],
      ['Risk and safety', 'Sport carries an inherent risk of injury. The Organisation will take reasonable care to run activities safely, with suitably qualified people, appropriate equipment and a safe environment. Nothing in this agreement limits liability that cannot lawfully be limited.'],
      ['Fees', 'Any fees are those agreed with the Organisation. Fees are payable on the dates agreed and the Organisation may pause participation while a fee is overdue after giving notice.'],
      ['Conduct', 'The Participant will treat coaches, staff, officials and other participants with respect and follow the Organisation\'s code of conduct. Serious or repeated breaches may lead to suspension or removal.'],
      ['Safeguarding', 'The Organisation follows its safeguarding policy. Concerns about the safety or welfare of any participant must be reported to the Organisation\'s safeguarding lead without delay.'],
      ['Personal data', 'The Organisation will use personal data only to run its activities and as described in its privacy notice, and will keep health and other sensitive information confidential and secure.'],
      ['Ending this agreement', 'Either party may end this agreement by written notice. Fees already paid are dealt with under the Organisation\'s refund policy.'],
    ],
  },
  {
    key: 'code_of_conduct', kind: 'code_of_conduct', title: 'Code of conduct', other: 'Member', publish: 'participation',
    summary: 'The behaviour expected of players, parents, coaches and officials.',
    clauses: [
      ['Respect', 'Everyone involved with the Organisation treats others fairly and with courtesy, on and off the field, including online. Abuse, discrimination, bullying and harassment are never acceptable.'],
      ['Fair play', 'Members play within the rules and the spirit of the sport, accept the decisions of officials and do not use banned substances or methods.'],
      ['Safety', 'Members follow safety instructions, use equipment correctly and tell a coach or staff member about any hazard or injury.'],
      ['Parents and spectators', 'Parents, guardians and spectators encourage positive play, leave coaching to the coaches and do not confront officials, players or staff.'],
      ['Social media and images', 'Members do not publish images or comments about other people without consent, and never share content that could embarrass, endanger or identify a child.'],
      ['Breaches', 'The Organisation may warn, suspend or remove anyone who breaches this code, after giving them a chance to respond except where safety requires immediate action.'],
    ],
  },
  {
    key: 'refund_policy', kind: 'refund_policy', title: 'Refund and cancellation policy', other: 'Participant', publish: 'participation',
    summary: 'When fees are refunded, credited or kept if someone withdraws or a session is cancelled.',
    clauses: [
      ['Withdrawal before the start', 'If the Participant withdraws before the programme starts, the Organisation refunds fees paid less any non-refundable deposit or registration fee stated at sign-up.'],
      ['Withdrawal after the start', 'After the start date fees are refunded only for sessions not yet delivered, and only where the Organisation can reallocate the place, unless the law requires otherwise.'],
      ['Cancellation by the Organisation', 'If the Organisation cancels a session or programme it will offer a replacement session, a credit or a refund of the fee for the cancelled sessions, at the Participant\'s choice.'],
      ['Weather and venue closures', 'Sessions lost to weather or venue closure are rescheduled where possible; otherwise a credit or refund is given for the lost sessions.'],
      ['Injury and illness', 'Where a Participant cannot attend for medical reasons and provides reasonable evidence, the Organisation will offer a credit or pro-rata refund.'],
      ['How refunds are paid', 'Refunds are paid to the original payment method within a reasonable time after approval.'],
    ],
  },
  {
    key: 'media_consent', kind: 'media_consent', title: 'Photo, video and media consent', other: 'Participant', publish: 'media',
    summary: 'Consent to photographs and recordings used by the organisation.',
    clauses: [
      ['What this covers', 'The Organisation may take photographs and video of activities and use them to run, review and promote its programmes, including on its website, apps, social media and printed material.'],
      ['Children', 'For a child, consent is given by a parent or guardian. Children are never named alongside an image unless the parent or guardian separately agrees.'],
      ['Your choices', 'Consent is optional, does not affect participation, and may be withdrawn at any time by telling the Organisation. New uses will stop; material already published will be removed where reasonably possible.'],
      ['Care', 'The Organisation will not use images in a way that is misleading, demeaning or unsafe, and will store originals securely.'],
    ],
  },
  {
    key: 'equipment', kind: 'equipment', title: 'Equipment and kit agreement', other: 'Participant', publish: 'participation',
    summary: 'Use, care, return and replacement of kit and equipment lent or sold by the organisation.',
    clauses: [
      ['Items', 'The Organisation provides or sells the kit and equipment listed at sign-up. Items lent remain the property of the Organisation.'],
      ['Care and use', 'The Participant will use equipment only for its intended purpose, take reasonable care of it and report damage or defects immediately.'],
      ['Return', 'Lent items must be returned when the programme ends or on request, in good condition allowing for fair wear and tear.'],
      ['Loss and damage', 'The Participant may be asked to pay the reasonable replacement or repair cost of items lost or damaged through misuse or negligence.'],
      ['Personal protective equipment', 'The Participant is responsible for wearing any protective equipment required for the sport and for making sure it fits properly.'],
    ],
  },
  {
    key: 'pickup', kind: 'pickup', title: 'Pick-up and drop-off agreement', other: 'Parent or guardian', publish: 'participation',
    summary: 'Who may collect a child and what happens when no one arrives.',
    clauses: [
      ['Authorised adults', 'Children are released only to the parent or guardian or to adults named in writing by them. Staff may ask for identification.'],
      ['Timing', 'Parents and guardians arrive on time for pick-up. Children are supervised until the stated end of the session.'],
      ['Late collection', 'If no one has collected a child after a reasonable wait, staff will try the emergency contacts and keep the child supervised by at least two adults until collected.'],
      ['Walking or travelling home alone', 'A child may leave unaccompanied only where a parent or guardian has given written permission.'],
    ],
  },
  {
    key: 'programme_declaration', kind: 'programme_declaration', title: 'Programme declaration', other: 'Participant', publish: 'participation',
    summary: 'A declaration that details given for a programme are accurate and the terms are understood.',
    clauses: [
      ['Accuracy', 'The Participant (or their parent or guardian) declares that the information supplied for this programme is accurate and complete, and will tell the Organisation promptly of any change.'],
      ['Terms', 'The Participant has read and accepts the programme terms, fees, code of conduct and policies published by the Organisation.'],
      ['Emergency treatment', 'The Organisation may arrange emergency medical treatment if the Participant cannot be consulted and will contact the emergency contacts as soon as possible.'],
    ],
  },
  {
    key: 'player_registration', kind: 'player_registration', title: 'Player registration and playing agreement', other: 'Player', publish: null,
    summary: 'Registration of a player with a team or club, with obligations on both sides.',
    clauses: [
      ['Registration', 'The Organisation registers the Player to represent its team(s) in the sport and competitions named in this agreement for the period stated.'],
      ['Commitments of the Player', 'The Player will attend training and matches as agreed, follow team rules and coaching instructions, maintain fitness and represent the Organisation with integrity.'],
      ['Commitments of the Organisation', 'The Organisation will provide coaching, a safe training and match environment, the agreed kit and any support or payments set out in this agreement.'],
      ['Payments and expenses', 'Any fees, stipend, match payments or expense reimbursements are those agreed in writing and are payable on the agreed dates.'],
      ['Eligibility and transfers', 'The Player confirms they are eligible to play under the rules of the competition and will not register elsewhere in the same competition without written release.'],
      ['Image and data', 'The Player consents to the Organisation using their name and image for team and competition purposes as separately agreed, and personal data is handled under the Organisation\'s privacy notice.'],
      ['Termination', 'Either party may end this agreement with the notice stated or for serious breach. Amounts earned to the end date remain payable.'],
    ],
  },
  {
    key: 'coaching_services', kind: 'coaching_services', title: 'Coaching services agreement', other: 'Coach', publish: null,
    summary: 'Engagement of a coach, trainer or other staff member, with fees, duties and safeguarding.',
    clauses: [
      ['Services', 'The Coach will provide the coaching services described in this agreement to the Organisation at the times and places agreed.'],
      ['Qualifications and checks', 'The Coach confirms that their qualifications, certifications, first-aid training and background or safeguarding checks are valid and will keep them current for the whole period.'],
      ['Fees and expenses', 'The Organisation will pay the agreed rate against invoices or timesheets by the agreed date and reimburse approved expenses.'],
      ['Status', 'The Coach is engaged in the capacity stated in this agreement. Tax and social contributions are the responsibility of the party the law requires.'],
      ['Safeguarding and conduct', 'The Coach will follow the Organisation\'s safeguarding policy and code of conduct and will never be alone with a child out of sight of other adults.'],
      ['Confidentiality and data', 'The Coach will keep athlete, family and Organisation information confidential and will use health and personal data only for the purpose of coaching.'],
      ['Intellectual property', 'Training plans and materials created for the Organisation under this agreement belong to the Organisation unless agreed otherwise in writing.'],
      ['Termination', 'Either party may end this agreement by written notice of the length stated, or immediately for serious misconduct or safeguarding concerns.'],
    ],
  },
  {
    key: 'venue_hire', kind: 'venue_hire', title: 'Venue hire agreement', other: 'Hirer', publish: null,
    summary: 'Hire of a pitch, court, hall or other facility.',
    clauses: [
      ['Hire period and space', 'The Organisation permits the Hirer to use the facility, on the dates and times stated, for the activity described. The Hirer leaves the facility on time and in a clean, tidy condition.'],
      ['Charges', 'The Hirer pays the agreed charges by the due date. Cancellation terms are those stated in this agreement.'],
      ['Use of the facility', 'The facility is used only for the stated activity, within capacity limits, and in line with house rules, safety signs and the instructions of staff.'],
      ['Insurance and liability', 'The Hirer holds appropriate public liability insurance and is responsible for loss or damage caused by the Hirer, its participants and spectators.'],
      ['Safety and first aid', 'The Hirer is responsible for the safe supervision of its participants, including having a qualified first aider where required.'],
      ['Cancellation by the Organisation', 'If the facility is unavailable for reasons outside its control the Organisation will offer an alternative time or a refund of the hire charge.'],
    ],
  },
  {
    key: 'event_participation', kind: 'event_participation', title: 'Event or tournament entry agreement', other: 'Entrant', publish: null,
    summary: 'Entry into an event, tournament or competition run by the organisation.',
    clauses: [
      ['Entry', 'The Organisation accepts the Entrant\'s entry to the event named in this agreement, subject to the event rules and eligibility requirements.'],
      ['Entry fee', 'Any entry fee is payable by the date stated and is refundable only as set out in the event rules.'],
      ['Rules and officials', 'The Entrant will follow the event rules and the decisions of officials. Disputes are raised through the process set out in the event rules.'],
      ['Eligibility and anti-doping', 'The Entrant confirms they are eligible, that the information supplied is true and that they will comply with applicable anti-doping rules.'],
      ['Risk and insurance', 'The Entrant understands the risks of the sport and confirms they hold, or have been offered, appropriate insurance cover.'],
      ['Media', 'The Organisation may record the event and use footage and results for reporting and promotion.'],
      ['Changes and cancellation', 'The Organisation may change the schedule or cancel the event for safety or other reasons beyond its control and will then refund or transfer entry fees as set out in the event rules.'],
    ],
  },
  {
    key: 'blank', kind: 'other', title: 'Custom agreement', other: 'Other party', publish: null,
    summary: 'Start from a clean structure and write or generate your own terms.',
    clauses: [
      ['Purpose', 'Describe what this agreement covers and why it is being made.'],
      ['Obligations', 'Set out what each party agrees to do.'],
      ['Term and ending', 'Say how long the agreement lasts and how either party may end it.'],
    ],
  },
];

export const templateByKey = (k) => AGREEMENT_TEMPLATES.find((t) => t.key === k);
export const AGREEMENT_KINDS = [...new Set(AGREEMENT_TEMPLATES.map((t) => t.kind))];
export const POLICY_KIND = (kind) => (['participation', 'code_of_conduct', 'refund_policy', 'media_consent', 'equipment', 'pickup', 'programme_declaration'].includes(kind) ? kind : 'other');

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const COUNTRY = (c) => { try { return c ? new Intl.DisplayNames(['en'], { type: 'region' }).of(c) : null; } catch { return c; } };

/** The agreement text for a template and the facts the wizard collected. Pure and deterministic; AI only ever edits this output. */
export function buildAgreementText({ template, organisation, legalName, counterparty, start, end, autoRenew, country, feeText }) {
  const t = template ?? templateByKey('blank');
  const org = legalName || organisation;
  const other = counterparty || `the ${t.other}`;
  const term = start ? `starts on ${fmt(start)}${end ? ` and runs until ${fmt(end)}` : ' and continues until ended under this agreement'}${autoRenew && end ? ', renewing automatically unless either party gives notice before the end date' : ''}` : 'starts when both parties have signed';
  const lines = [
    t.title.toUpperCase(), '',
    `This agreement is made between ${org} ("${ORG}") and ${other} ("the ${t.other}"). It ${term}.`, '',
  ];
  let n = 1;
  for (const [h, body] of t.clauses.map(([a, b]) => [a, b.replaceAll('the Participant', `the ${t.other}`).replaceAll('The Participant', `The ${t.other}`)])) { lines.push(`${n}. ${h}`, body, ''); n++; }
  if (feeText) { lines.push(`${n}. Fees`, feeText, ''); n++; }
  lines.push(`${n}. General`, `This agreement is the whole agreement between the parties on its subject. Changes must be in writing and agreed by both parties.${country ? ` It is governed by the laws of ${COUNTRY(country)}.` : ''}`, '');
  return lines.join('\n').trim();
}

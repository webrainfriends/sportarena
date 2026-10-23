// Standard application-form templates for sponsorship programs. A brand picks one (or describes what it funds and lets the AI tailor it),
// then edits the questions before publishing. Templates are plain form definitions: the same shape `formDefinition` validates, so a
// template and a published version are interchangeable. Pure data, no I/O.
const T = (key, label, type, o = {}) => ({ key, label, type, required: false, confidential: false, ...o });
const opts = (...labels) => labels.map((label) => ({ value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60), label }));
const contact = (extra = []) => ({
  id: 'about_you', title: 'About you', fields: [
    T('org_name', 'Name of the applicant', 'text', { required: true, profile_key: 'org_name' }),
    T('contact_phone', 'Contact phone', 'text', { required: true, confidential: true, profile_key: 'contact_phone', hint: 'Only staff reviewing your application can see this.' }),
    T('website', 'Website or social profile', 'text', { profile_key: 'website' }),
    ...extra,
  ],
});
const money = (what) => ({
  id: 'budget_and_proof', title: 'Budget and proof', fields: [
    T('budget', `Itemised budget for ${what}`, 'budget', { required: true, hint: 'List each cost. The total must cover the amount you request.' }),
    T('other_funding', 'Is other funding already secured?', 'yesno', { required: true }),
    T('other_funding_detail', 'Who else is funding it, and how much?', 'longtext', { when: { field: 'other_funding', op: 'eq', value: true } }),
    T('proof', 'Supporting document', 'file', { max_files: 3, hint: 'A registration, quote, fixture list or similar (PDF or photo).' }),
    T('refs', 'References', 'references', { required: true, max_items: 2, hint: 'People who can vouch for you. Nobody is contacted unless they agree.' }),
  ],
});

export const FORM_TEMPLATES = [
  {
    key: 'general', name: 'General sponsorship application', best_for: 'Any program',
    summary: 'A short, balanced form: who is applying, what the money is for, the impact and a budget.',
    sections: () => [
      contact(),
      { id: 'proposal', title: 'Your proposal', fields: [
        T('summary', 'Describe what you want funded', 'longtext', { required: true, hint: 'What will happen, where and for whom?' }),
        T('sport', 'Main sport', 'text', { required: true }),
        T('start', 'Planned start date', 'date', { required: true }),
        T('impact', 'What difference will this make?', 'longtext', { required: true }),
        T('visibility', 'How will you recognise the sponsor?', 'multi', { options: opts('Logo on kit', 'Logo on website', 'Social media posts', 'Event signage', 'Public thank-you', 'Content for the brand') }),
      ] },
      money('the project'),
    ],
  },
  {
    key: 'athlete', name: 'Athlete sponsorship', best_for: 'Individual athletes',
    summary: 'Level, results, goals for the season and how the funds will be used. Adds a guardian question for under-18s.',
    sections: () => [
      contact([T('age_group', 'Are you under 18?', 'yesno', { required: true }),
        T('guardian_name', 'Parent or guardian name', 'text', { required: true, confidential: true, when: { field: 'age_group', op: 'eq', value: true } })]),
      { id: 'athlete', title: 'Your sport', fields: [
        T('sport', 'Sport', 'text', { required: true }),
        T('level', 'Current level', 'choice', { required: true, options: opts('Beginner', 'Club', 'Regional', 'National', 'International') }),
        T('achievements', 'Results and achievements so far', 'longtext', { required: true }),
        T('coach', 'Who coaches you?', 'text'),
        T('goals', 'Goals for the next 12 months', 'longtext', { required: true }),
        T('story', 'Why should a sponsor back you?', 'longtext', { required: true }),
      ] },
      { id: 'funds', title: 'How the funds will be used', fields: [
        T('use', 'Funding will mostly cover', 'multi', { required: true, options: opts('Coaching', 'Travel', 'Competition fees', 'Equipment and kit', 'Medical and recovery', 'Training facilities') }),
        T('budget', 'Itemised season budget', 'budget', { required: true }),
        T('proof', 'Results, rankings or selection letter', 'file', { max_files: 3 }),
        T('refs', 'References (coach, club or school)', 'references', { required: true, max_items: 2 }),
      ] },
    ],
  },
  {
    key: 'team', name: 'Team or club sponsorship', best_for: 'Teams, clubs and academies',
    summary: 'The squad, season, competitions and the sponsor benefits you can offer in return.',
    sections: () => [
      contact(),
      { id: 'team', title: 'The team', fields: [
        T('sport', 'Sport', 'text', { required: true }),
        T('members', 'Number of players', 'number', { required: true, min: 1, max: 5000 }),
        T('founded', 'Year founded', 'number', { min: 1800, max: 2100 }),
        T('competitions', 'Leagues and competitions entered', 'longtext', { required: true }),
        T('season_start', 'Season starts', 'date', { required: true }),
        T('youth', 'Does the team include players under 18?', 'yesno', { required: true }),
        T('safeguarding', 'Describe your safeguarding policy', 'longtext', { required: true, when: { field: 'youth', op: 'eq', value: true } }),
      ] },
      { id: 'offer', title: 'What the sponsor gets', fields: [
        T('reach', 'Typical match-day or social media audience', 'text'),
        T('benefits', 'Benefits you can offer', 'multi', { required: true, options: opts('Shirt sponsor', 'Training kit logo', 'Ground signage', 'Social media features', 'Match-day naming rights', 'Community events') }),
        T('summary', 'How will this sponsorship help the team?', 'longtext', { required: true }),
      ] },
      money('the season'),
    ],
  },
  {
    key: 'event', name: 'Event sponsorship', best_for: 'Tournaments, leagues and festivals',
    summary: 'Dates, venue, audience, sponsor packages and the budget behind the event.',
    sections: () => [
      contact(),
      { id: 'event', title: 'The event', fields: [
        T('event_name', 'Event name', 'text', { required: true }),
        T('sport', 'Sport', 'text', { required: true }),
        T('starts', 'Starts on', 'date', { required: true }),
        T('ends', 'Ends on', 'date', { required: true }),
        T('venue', 'Venue and city', 'text', { required: true }),
        T('participants', 'Expected participants', 'number', { required: true, min: 1, max: 100000 }),
        T('spectators', 'Expected spectators', 'number', { min: 0, max: 1000000 }),
        T('past', 'Has the event run before?', 'yesno', { required: true }),
        T('past_results', 'Previous turnout and outcomes', 'longtext', { when: { field: 'past', op: 'eq', value: true } }),
      ] },
      { id: 'packages', title: 'Sponsor value', fields: [
        T('benefits', 'Sponsor benefits on offer', 'multi', { required: true, options: opts('Title naming rights', 'Logo on banners', 'Logo on kit and bibs', 'Stall or activation space', 'Live-stream mentions', 'Podium presence', 'Hospitality tickets') }),
        T('media', 'Planned media coverage', 'longtext'),
        T('summary', 'Why should a brand sponsor this event?', 'longtext', { required: true }),
      ] },
      money('the event'),
    ],
  },
  {
    key: 'youth', name: 'Youth and community programme', best_for: 'Grassroots and development programmes',
    summary: 'Who it reaches, safeguarding, outcomes you will measure and how you will report back.',
    sections: () => [
      contact(),
      { id: 'programme', title: 'The programme', fields: [
        T('summary', 'What does the programme do?', 'longtext', { required: true }),
        T('sport', 'Sport or sports', 'text', { required: true }),
        T('age_range', 'Age range reached', 'choice', { required: true, options: opts('Under 8', '8 to 12', '13 to 17', 'Adults', 'All ages') }),
        T('participants', 'Participants per year', 'number', { required: true, min: 1, max: 100000 }),
        T('inclusion', 'Groups you aim to include', 'multi', { options: opts('Girls and women', 'People with disabilities', 'Low-income families', 'Refugees and newcomers', 'Rural communities') }),
        T('start', 'Starts on', 'date', { required: true }),
      ] },
      { id: 'safety', title: 'Safeguarding and impact', fields: [
        T('policy', 'Do you have a written safeguarding policy?', 'yesno', { required: true }),
        T('policy_doc', 'Upload your policy', 'file', { max_files: 2, when: { field: 'policy', op: 'eq', value: true } }),
        T('checks', 'Are coaches and volunteers background-checked?', 'yesno', { required: true }),
        T('outcomes', 'Outcomes you will measure', 'longtext', { required: true }),
        T('reporting', 'How often will you report to the sponsor?', 'choice', { required: true, options: opts('Monthly', 'Quarterly', 'Twice a year', 'End of programme') }),
      ] },
      money('the programme'),
    ],
  },
];

export const templateDefinition = (key) => { const t = FORM_TEMPLATES.find((x) => x.key === key); return t ? { sections: t.sections() } : null; };
export const templateList = () => FORM_TEMPLATES.map((t) => { const definition = { sections: t.sections() };
  return { key: t.key, name: t.name, best_for: t.best_for, summary: t.summary, sections: definition.sections.length, questions: definition.sections.reduce((n, s) => n + s.fields.length, 0), definition }; });

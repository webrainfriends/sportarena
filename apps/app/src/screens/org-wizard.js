// Creating an organisation: a guided form with identity, legal details, contact, a full address and the teams to link. Every field after the name
// is optional (city or area is enough for an address), and everything can be edited later from the organisation's Overview.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Row, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Stepper } from '../pickers';
import { countryName } from '../country-picker';
import { c } from '../theme';
import { explain } from '../access';

export const ORG_KINDS = [['club', 'Club'], ['academy', 'Academy'], ['school', 'School'], ['college', 'College'], ['university', 'University'], ['company', 'Company'], ['other', 'Other']];
const STEPS = ['Basics', 'Legal', 'Contact', 'Address', 'Teams', 'Review'];
const kindOptions = ORG_KINDS.map(([value, label]) => ({ value, label }));

/** Fields shared by the wizard and the "Edit details" sheet, so one definition describes an organisation. */
export const profileFields = {
  basics: [
    { key: 'name', label: 'Organisation name' },
    { key: 'kind', label: 'Type', type: 'chips', options: kindOptions },
    { key: 'description', label: 'About the organisation', type: 'multiline', optional: true, hint: 'A sentence or two. Members and families can read this.' },
  ],
  legal: [
    { key: 'legal_name', label: 'Registered legal name', optional: true, hint: 'If different from the name above. It appears on agreements and invoices.' },
    { key: 'registration_no', label: 'Registration number', optional: true },
    { key: 'tax_id', label: 'Tax / GST / VAT number', optional: true },
    { key: 'founded_on', label: 'Founded on', type: 'date', optional: true, max: new Date().toISOString().slice(0, 10) },
  ],
  contact: [
    { key: 'contact_email', label: 'Contact email', input: 'email', optional: true },
    { key: 'contact_phone', label: 'Contact phone', input: 'phone', optional: true },
    { key: 'website', label: 'Website', input: 'url', optional: true },
  ],
};
export const addressFields = [
  { key: 'locality', label: 'City or town', type: 'region', optional: true, hint: 'Search, or add your own.' },
  { key: 'area', label: 'Area or district', optional: true },
  { key: 'line1', label: 'Street address', optional: true },
  { key: 'line2', label: 'Building, landmark', optional: true },
  { key: 'region', label: 'State or province', optional: true },
  { key: 'postal_code', label: 'Postal code', optional: true },
  { key: 'country', label: 'Country', type: 'country', optional: true },
];
const ADDRESS_KEYS = addressFields.map((f) => f.key);

export function OrgWizard({ visible, onClose, onCreated }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [v, setV] = useState({ kind: 'club', team_ids: [] });
  const [busy, setBusy] = useState(false);
  const teams = useLoad(() => (visible ? api.get('/teams', { mine: true }).catch(() => []) : Promise.resolve([])), [visible]);
  const free = (Array.isArray(teams.data) ? teams.data : teams.data?.items ?? []).filter((t) => !t.organisation_id);
  const next = (patch) => { setV((x) => ({ ...x, ...patch })); setStep((s) => s + 1); };
  const back = () => setStep((s) => Math.max(0, s - 1));
  const close = () => { setStep(0); setV({ kind: 'club', team_ids: [] }); onClose(); };
  const address = Object.fromEntries(ADDRESS_KEYS.filter((k) => v[k]).map((k) => [k, v[k]]));
  const create = async () => {
    setBusy(true);
    try {
      const body = Object.fromEntries(['name', 'kind', 'description', 'legal_name', 'registration_no', 'tax_id', 'founded_on', 'contact_email', 'contact_phone', 'website'].filter((k) => v[k]).map((k) => [k, v[k]]));
      if (Object.keys(address).length) body.address = address;
      if (v.team_ids?.length) body.team_ids = v.team_ids;
      const o = await api.post('/organisations', body);
      toast('Organisation created');
      close(); onCreated?.(o);
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const line = [address.line1, address.line2, address.area, address.locality, address.region, address.postal_code, address.country ? countryName(address.country) : ''].filter(Boolean).join(', ');
  return (
    <Sheet visible={visible} onClose={close} title="New organisation">
      <Stepper steps={STEPS} current={step} onJump={(i) => i <= step && setStep(i)} />
      {step === 0 ? <FormSheet inline visible initial={v} submitLabel="Next: legal details" onClose={() => {}} fields={profileFields.basics} onSubmit={async (x) => next(x)} /> : null}
      {step === 1 ? <FormSheet inline visible initial={v} submitLabel="Next: contact" onBack={back} onClose={() => {}} fields={profileFields.legal} onSubmit={async (x) => next(x)} /> : null}
      {step === 2 ? <FormSheet inline visible initial={v} submitLabel="Next: address" onBack={back} onClose={() => {}} fields={profileFields.contact} onSubmit={async (x) => next(x)} /> : null}
      {step === 3 ? <FormSheet inline visible initial={v} submitLabel="Next: teams" onBack={back} onClose={() => {}} fields={addressFields} onSubmit={async (x) => next(x)} /> : null}
      {step === 4 ? (
        <FormSheet inline visible initial={v} submitLabel="Next: review" onBack={back} onClose={() => {}}
          fields={[{ key: 'team_ids', label: 'Teams to link', type: 'multi', optional: true, options: free.map((t) => ({ value: t.id, label: t.name })),
            hint: free.length ? 'Pick teams you own to bring into this organisation.' : 'You have no unlinked teams yet. After creating the organisation, add or create teams from its Teams tab.' }]}
          onSubmit={async (x) => next(x)} />
      ) : null}
      {step === 5 ? (
        <View style={{ gap: 10 }}>
          <Row title={v.name} sub={`${ORG_KINDS.find(([k]) => k === v.kind)?.[1]}${v.legal_name ? ` · ${v.legal_name}` : ''}`} />
          {v.registration_no || v.tax_id ? <Row title="Registration" sub={[v.registration_no && `Reg ${v.registration_no}`, v.tax_id && `Tax ${v.tax_id}`].filter(Boolean).join(' · ')} /> : null}
          {v.contact_email || v.contact_phone || v.website ? <Row title="Contact" sub={[v.contact_email, v.contact_phone, v.website].filter(Boolean).join(' · ')} /> : null}
          <Row title="Address" sub={line || 'Not added yet'} />
          <Row title="Teams" sub={v.team_ids?.length ? free.filter((t) => v.team_ids.includes(t.id)).map((t) => t.name).join(', ') : 'None yet'} />
          <T size={12} color={c.mute}>You become the owner. Add a brand kit with your logo from Branded documents so agreements and invoices carry it.</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="Back" color={c.paper} ink={c.ink} onPress={back} style={{ flex: 1 }} />
            <Btn title="Create organisation" onPress={create} loading={busy} style={{ flex: 2 }} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

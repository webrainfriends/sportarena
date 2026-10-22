import React, { useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { countryName } from '../country-picker';
import { c } from '../theme';

const TYPES = [{ value: 'company', label: 'Company' }, { value: 'organization', label: 'Organization' }, { value: 'individual', label: 'Individual' }];
const TYPE_LABEL = { company: 'Company', organization: 'Organization', individual: 'Individual' };
const ROLES = [{ value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }, { value: 'finance', label: 'Finance' }, { value: 'portfolio_manager', label: 'Portfolio manager' }, { value: 'viewer', label: 'Viewer' }];
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));
const ROLE_HELP = { owner: 'Everything, including owners', admin: 'Identity, team, portfolios, offers', finance: 'Payments only', portfolio_manager: 'Offers for assigned portfolios only', viewer: 'Read only' };
const PRIVATE = ['registration_number', 'tax_id', 'billing_email', 'billing_address'];

/** Why a read failed, in words the person can act on. */
const why = (e) => (e?.status === 404 ? 'This sponsor is not available to you. Ask an owner to invite you, or check you are signed in with the right account.' : e?.status === 403 ? 'Your role does not allow this.' : e?.message ?? 'Something went wrong.');

/** One sponsor brand's legal identity, authorised team, portfolios and sibling brands. */
export function SponsorIdentity({ id }) {
  const { toast } = useSession();
  const idn = useLoad(() => api.get(`/sponsors/${id}/identity`), [id]);
  const d = idn.data;
  const eid = d?.entity_id;
  const reps = useLoad(() => (eid && d?.can_edit ? api.get(`/sponsor-entities/${eid}/representatives`, { limit: 100 }) : Promise.resolve([])), [eid, d?.can_edit]);
  const folios = useLoad(() => (eid ? api.get(`/sponsor-entities/${eid}/portfolios`) : Promise.resolve([])), [eid]);
  const mine = useLoad(() => api.get('/me/sponsor-identities', { limit: 100 }), [id]);
  const orgs = useLoad(() => api.get('/organisations'), []);
  const [form, setForm] = useState(null); // 'identity' | 'brand' | { portfolio } | 'attach'
  const [invite, setInvite] = useState(null); // { who, role, also }
  const [stale, setStale] = useState(false);
  const version = useRef(null);
  version.current = d?.row_version;
  const reloadAll = () => { idn.reload(); reps.reload(); folios.reload(); mine.reload(); };
  const act = async (fn, m) => { try { await fn(); toast(m); reloadAll(); } catch (e) { toast(why(e)); } };

  if (idn.loading && !d) return <Screen><Loading /></Screen>;
  if (idn.error) return <Screen><H1>Sponsor identity</H1><ErrorBox error={{ message: why(idn.error) }} onRetry={idn.error.status === 404 || idn.error.status === 403 ? undefined : idn.reload} /></Screen>;
  const edit = d.can_edit, owner = d.my_role === 'owner';
  const managers = (reps.data ?? []).filter((r) => r.role === 'portfolio_manager' && r.status === 'active');
  const otherEntities = (mine.data?.entities ?? []).filter((e) => e.id !== eid && ['owner', 'admin'].includes(e.my_role));
  const currentValues = { sponsor_type: d.sponsor_type ?? 'company', legal_name: d.legal_name ?? '', registration_country: d.registration_country ?? '', registration_number: d.registration_number ?? '', tax_id: d.tax_id ?? '', billing_email: d.billing_email ?? '', billing_address: d.billing_address ?? '', organisation_id: d.organisation_id ?? undefined };

  const saveIdentity = async (v) => {
    const body = { ...v };
    // a field the person emptied is cleared, not silently kept
    for (const k of ['legal_name', 'registration_country', ...PRIVATE]) if (body[k] === undefined && currentValues[k]) body[k] = null;
    if (body.organisation_id === undefined && d.organisation_id) body.organisation_id = null;
    if (eid) body.row_version = version.current;
    try { await api.post(`/sponsors/${id}/identity`, body); setStale(false); reloadAll(); return 'Identity saved'; }
    catch (e) {
      if (e.status === 409) { setStale(true); idn.reload(); throw new Error('Someone else changed this identity just now. The latest version is loaded behind this form; review your entries and save again.'); }
      throw e;
    }
  };
  const doExport = async () => {
    try {
      const out = JSON.stringify(await api.get(`/sponsor-entities/${eid}/export`), null, 2);
      if (Platform.OS === 'web' && typeof document !== 'undefined') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/json' })); a.download = 'sponsor-identity.json'; a.click(); toast('Export downloaded'); }
      else await Share.share({ message: out });
    } catch (e) { toast(why(e)); }
  };
  const sendInvites = async () => {
    const targets = [eid, ...invite.also];
    const failed = [];
    for (const t of targets) { try { await api.post(`/sponsor-entities/${t}/representatives`, { user_id: invite.who.id, role: invite.role }); } catch (e) { failed.push(e.message); } }
    if (failed.length) toast(`Some invitations failed: ${failed[0]}`); else toast('Invitation sent');
    setInvite(null); reloadAll();
  };

  return (
    <Screen>
      <H1>{d.display_name}</H1>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {d.sponsor_type ? <Tag label={TYPE_LABEL[d.sponsor_type]} color={c.violetSoft} /> : <Tag label="Identity not confirmed" color={c.sunSoft} />}
        <Tag label={`Your role: ${ROLE_LABEL[d.my_role] ?? d.my_role}`} color={c.paper} />
      </View>
      <T size={12} color={c.mute}>Private. Legal and billing details are never shown in the sponsor directory or on your public profile.</T>

      <Section title="Legal & billing identity" color={c.violet}>
        {stale ? <Card color={c.sunSoft}><T weight="800">This identity changed while you were editing.</T><T size={12}>The latest version is shown below. Re-open the form to review and save again.</T></Card> : null}
        {!d.identity_confirmed ? <Card color={c.sunSoft}><T weight="800">No legal identity confirmed yet</T><T size={12}>Nothing has been filled in for you. Confirm who is behind this brand to unlock verification and team access.</T></Card> : (
          <Card>
            <T weight="900">{d.legal_name ?? 'Legal name not set'}</T>
            <T size={12} color={c.mute}>{TYPE_LABEL[d.sponsor_type]}{d.registration_country ? ` · ${countryName(d.registration_country)}` : ''}{d.organisation_id ? ' · linked organisation' : ''}</T>
            {edit ? <>
              <T size={13} style={{ marginTop: 6 }}>Registration no.: {d.registration_number ?? '—'}</T>
              <T size={13}>Tax / VAT id: {d.tax_id ?? '—'}</T>
              <T size={13}>Billing email: {d.billing_email ?? '—'}</T>
              <T size={13}>Billing address: {d.billing_address ?? '—'}</T>
              <T size={11} color={c.mute}>Encrypted at rest; reading them here is audit-logged.</T>
            </> : <T size={12} color={c.mute}>Registration, tax and billing details are visible to owners and admins only.</T>}
          </Card>)}
        {edit ? <Btn title={d.identity_confirmed ? 'Edit identity' : 'Confirm identity'} color={c.pink} onPress={() => setForm('identity')} /> : <T size={12} color={c.mute}>Only an owner or admin can change this identity.</T>}
        {!d.identity_confirmed && edit && otherEntities.length ? <Btn small title="Move under one of my sponsors" color={c.paper} ink={c.ink} onPress={() => setForm('attach')} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>

      {d.identity_confirmed ? (
        <Section title="Authorised representatives" color={c.cyan}>
          {!edit ? <T size={13} color={c.mute}>Only owners and admins see the full team.</T> : reps.loading && !reps.data ? <Loading /> : reps.error ? <ErrorBox error={reps.error} onRetry={reps.reload} /> : (
            <>
              {reps.data.filter((r) => ['active', 'invited'].includes(r.status)).map((r) => (
                <Row key={r.id} title={`${r.display_name}${r.status === 'invited' ? ' · invited' : ''}`} sub={`${ROLE_LABEL[r.role]}${r.portfolios.length ? ` · ${r.portfolios.map((p) => p.name).join(', ')}` : ''}`}
                  right={(owner || !['owner', 'admin'].includes(r.role)) ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Btn small title="Change role" color={c.paper} ink={c.ink} onPress={() => setForm({ role: r })} />
                    <Btn small title={r.status === 'invited' ? 'Cancel' : 'Remove'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsor-representatives/${r.id}/remove`), r.status === 'invited' ? 'Invitation cancelled' : 'Access ended — past agreements keep their history')} />
                  </View> : null} />))}
              {!reps.data.some((r) => ['active', 'invited'].includes(r.status)) ? <Empty emoji="👥" title="Only you so far" sub="Invite colleagues with the role they need." /> : null}
              {reps.data.some((r) => r.status === 'left') ? <T size={12} color={c.mute}>{reps.data.filter((r) => r.status === 'left').length} former representative(s) are kept on record.</T> : null}
              <Btn small title="+ Invite person" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setInvite({ who: null, role: 'viewer', also: [] })} />
            </>)}
          <Btn small title="Leave this sponsor" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start' }} onPress={() => act(async () => { const me = (mine.data?.entities ?? []).find((e) => e.id === eid); if (!me) throw new Error('Reload and try again'); await api.post(`/sponsor-representatives/${me.representative_id}/remove`); }, 'You left this sponsor')} />
        </Section>) : null}

      {d.identity_confirmed ? (
        <Section title="Portfolios" color={c.mint}>
          {folios.loading && !folios.data ? <Loading /> : folios.error ? <ErrorBox error={folios.error} onRetry={folios.reload} /> : folios.data.length ? folios.data.map((p) => (
            <Card key={p.id}><T weight="900">{p.name}</T>
              <T size={12} color={c.mute}>{p.brands.map((b) => b.name).join(', ') || 'No brands yet'}</T>
              <T size={12} color={c.mute}>Managers: {p.managers.map((m) => m.display_name).join(', ') || 'none assigned'}</T>
              {edit ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ portfolio: p })} /><Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsor-portfolios/${p.id}`, { archived: true }), 'Portfolio archived')} /></View> : null}
            </Card>)) : <Empty emoji="🗂️" title="No portfolios" sub={edit ? 'Group brands and give a portfolio manager just those.' : 'You can see portfolios assigned to you here.'} />}
          {edit ? <Btn small title="+ New portfolio" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setForm({ portfolio: {} })} /> : null}
        </Section>) : null}

      {d.identity_confirmed ? (
        <Section title="Brands under this sponsor" color={c.pink}>
          {d.brands.map((b) => <Row key={b.id} title={`${b.emoji ?? ''} ${b.name}`.trim()} sub={b.id === id ? 'This brand' : undefined} />)}
          {edit ? <Btn small title="+ Add brand" color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('brand')} /> : null}
          {edit ? <Btn small title="Export identity data" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={doExport} /> : null}
        </Section>) : null}

      <FormSheet visible={form === 'identity'} onClose={() => setForm(null)} title={d.identity_confirmed ? 'Edit identity' : 'Confirm identity'} initial={currentValues}
        fields={[
          { key: 'sponsor_type', label: 'Who is the sponsor?', type: 'choice', options: TYPES },
          { key: 'legal_name', label: 'Legal name', hint: 'As on your registration or ID. Private.', optional: true },
          { key: 'registration_country', label: 'Country of registration or residence', type: 'country', optional: true },
          { key: 'registration_number', label: 'Registration number', optional: true, hint: 'Encrypted.', show: (v) => v.sponsor_type !== 'individual' },
          { key: 'tax_id', label: 'Tax / VAT id', optional: true, hint: 'Encrypted.' },
          { key: 'billing_email', label: 'Billing email', optional: true, input: 'email', hint: 'Encrypted.' },
          { key: 'billing_address', label: 'Billing address', type: 'multiline', optional: true, hint: 'Encrypted.' },
          { key: 'organisation_id', label: 'Linked organisation', type: 'chips', optional: true, options: (orgs.data ?? []).map((o) => ({ value: o.id, label: o.name })), show: (v) => v.sponsor_type === 'organization' && (orgs.data ?? []).length > 0, hint: 'Only organisations you own or administer.' }]}
        onSubmit={saveIdentity} />
      <FormSheet visible={form === 'brand'} onClose={() => setForm(null)} title="Add a brand" fields={[{ key: 'name', label: 'Brand name' }, { key: 'industry', label: 'Industry', optional: true }]}
        onSubmit={async (v) => { await api.post('/sponsors', { ...v, entity_id: eid }); reloadAll(); return 'Brand added'; }} />
      <FormSheet visible={form === 'attach'} onClose={() => setForm(null)} title="Move under a sponsor" submitLabel="Move" fields={[{ key: 'entity_id', label: 'Sponsor', type: 'chips', options: otherEntities.map((e) => ({ value: e.id, label: e.legal_name ?? 'Unnamed sponsor' })) }]}
        onSubmit={async (v) => { await api.post(`/sponsors/${id}/entity`, v); reloadAll(); return 'Brand moved — agreements and history are untouched'; }} />
      <FormSheet visible={!!form?.role} onClose={() => setForm(null)} title={`Role for ${form?.role?.display_name ?? ''}`} initial={{ role: form?.role?.role, title: form?.role?.title ?? '' }}
        fields={[{ key: 'role', label: 'Role', type: 'chips', options: ROLES.filter((r) => owner || !['owner', 'admin'].includes(r.value)).map((r) => ({ value: r.value, label: `${r.label} — ${ROLE_HELP[r.value]}` })) }, { key: 'title', label: 'Job title', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/sponsor-representatives/${form.role.id}`, { role: v.role, title: v.title ?? null }); reloadAll(); return 'Updated'; }} />
      <FormSheet visible={!!form?.portfolio} onClose={() => setForm(null)} title={form?.portfolio?.id ? 'Edit portfolio' : 'New portfolio'} initial={{ name: form?.portfolio?.name ?? '', sponsor_ids: (form?.portfolio?.brands ?? []).map((b) => b.id), manager_ids: (form?.portfolio?.managers ?? []).map((m) => m.representative_id) }}
        fields={[{ key: 'name', label: 'Portfolio name' }, { key: 'sponsor_ids', label: 'Brands in this portfolio', type: 'multi', optional: true, options: d.brands.map((b) => ({ value: b.id, label: b.name })) },
          { key: 'manager_ids', label: 'Portfolio managers', type: 'multi', optional: true, options: managers.map((m) => ({ value: m.id, label: m.display_name })), hint: managers.length ? 'They can act only for the brands above.' : 'Invite someone as a portfolio manager first.' }]}
        onSubmit={async (v) => { const body = { name: v.name, sponsor_ids: v.sponsor_ids ?? [], manager_ids: v.manager_ids ?? [] }; if (form.portfolio.id) await api.patch(`/sponsor-portfolios/${form.portfolio.id}`, body); else await api.post(`/sponsor-entities/${eid}/portfolios`, body); reloadAll(); return 'Portfolio saved'; }} />
      <Sheet visible={!!invite} onClose={() => setInvite(null)} title="Invite a representative">
        {invite ? <View style={{ gap: 12 }}>
          <EntityPicker label="Person" value={invite.who ? [{ id: invite.who.id, label: invite.who.label }] : []} onChange={(v) => setInvite({ ...invite, who: v[0] ?? null })} />
          <T weight="800" size={13}>Role</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{ROLES.filter((r) => owner || !['owner', 'admin'].includes(r.value)).map((r) => <Chip key={r.value} label={r.label} active={invite.role === r.value} onPress={() => setInvite({ ...invite, role: r.value })} />)}</View>
          <T size={12} color={c.mute}>{ROLE_HELP[invite.role]}. They get access only after accepting.</T>
          {otherEntities.length ? <>
            <T weight="800" size={13}>Also invite to my other sponsors (optional)</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{otherEntities.map((e) => <Chip key={e.id} label={e.legal_name ?? 'Unnamed sponsor'} active={invite.also.includes(e.id)} onPress={() => setInvite({ ...invite, also: invite.also.includes(e.id) ? invite.also.filter((x) => x !== e.id) : [...invite.also, e.id] })} />)}</View>
          </> : null}
          <Btn title="Send invitation" color={c.pink} disabled={!invite.who} onPress={sendInvites} />
        </View> : null}
      </Sheet>
    </Screen>
  );
}

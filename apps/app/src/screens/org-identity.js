// Organisation workspace · Sign-in & access (#521). Single sign-on (OIDC / SAML), the verified email domain, group-to-role mappings,
// the directory (SCIM) credential, the access review and the identity log - all on the organisation's own screen, calling the same API
// capabilities as MCP and REST. The server enforces every rule (role ceiling, owner-only changes); the screen only hides what a role cannot use.
import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Confirm } from './coaching';
import { explain } from '../access';
import { c } from '../theme';

const ROLE_LABEL = { admin: 'Admin', coach: 'Coach', finance: 'Finance', staff: 'Staff', manager: 'Sponsor manager', evaluator: 'Evaluator', approver: 'Approver', auditor: 'Auditor' };
const STATUS = { draft: ['Not live', c.sun], active: ['Live', c.mint], disabled: ['Off', c.orange] };
const SOURCE = { manual: 'Added by an admin', sso: 'Single sign-on', scim: 'Directory (SCIM)' };
const when = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const roleOptions = (list) => list.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));

/** Selectable text that is also shareable/copyable on every platform (native Share sheet, browser clipboard). */
function Copyable({ label, value }) {
  const copy = async () => {
    try {
      if (Platform.OS === 'web' && navigator?.clipboard) await navigator.clipboard.writeText(value); else await Share.share({ message: value });
    } catch { /* the text below is selectable as a fallback */ }
  };
  return (
    <View style={{ gap: 4 }}>
      <T size={12} color={c.mute} weight="800">{label}</T>
      <T size={13} selectable style={{ fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }}>{value}</T>
      <Btn small title={`Copy ${label}`} color={c.paper} ink={c.ink} onPress={copy} style={{ alignSelf: 'flex-start' }} accessibilityLabel={`Copy ${label}`} />
    </View>
  );
}

export function OrgIdentity({ o, role, archived, toast }) {
  const owner = role === 'owner' && !archived;
  const sso = useLoad(() => api.get(`/organisations/${o.id}/identity/sso`), [o.id]);
  const review = useLoad(() => api.get(`/organisations/${o.id}/identity/access-review`, { limit: 100 }), [o.id]);
  const events = useLoad(() => api.get(`/organisations/${o.id}/identity/events`, { limit: 20 }), [o.id]);
  const [sheet, setSheet] = useState(null);       // 'domain' | 'connection' | 'mapping'
  const [token, setToken] = useState(null);       // a freshly created SCIM token, shown once
  const [confirm, setConfirm] = useState(null);   // { person }
  const [busy, setBusy] = useState(false);
  const reloadAll = () => { sso.reload(); review.reload(); events.reload(); };
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); reloadAll(); return r; } catch (e) { toast(explain(e)); } finally { setBusy(false); } };

  const exportReview = async () => {
    try {
      const r = await api.get(`/organisations/${o.id}/export`, { section: 'access_review' });
      if (Platform.OS === 'web' && typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); } else await Share.share({ message: r.csv, title: r.filename });
      toast(`${r.rows} rows exported`);
    } catch (e) { toast(explain(e)); }
  };

  if (sso.error) return <ErrorBox error={sso.error} onRetry={sso.reload} />;
  if (!sso.data) return <Loading />;
  const { connection: conn, mappings, scim, domains, provisionable_roles: provisionable } = sso.data;
  const verified = domains.filter((d) => d.status === 'verified');
  const live = conn?.status === 'active';
  const st = conn ? STATUS[conn.status] : ['Not set up', c.sun];
  const sp = conn?.service_provider;

  return (
    <>
      <Section title="Single sign-on" color={c.violet}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag label={st[0]} color={st[1]} />
          {conn ? <Tag label={conn.protocol === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'} /> : null}
          {conn?.test_ok === true ? <Tag label="Tested ✓" color={c.mint} /> : conn?.test_ok === false ? <Tag label="Test failed" color={c.orange} /> : null}
        </View>
        <T size={13} color={c.mute} style={{ marginTop: 6 }}>
          {conn ? 'People with an address on a verified domain can sign in with your identity provider. Passwords and personal accounts keep working unless you require SSO.' : 'Connect your identity provider so staff sign in with their work account. Each person stays one Gotmygame account and can belong to several organisations.'}
        </T>
        {conn?.test_detail ? <T size={12} color={conn.test_ok ? c.mute : c.red} style={{ marginTop: 4 }}>{conn.test_detail}</T> : null}
        {owner ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <Btn small title={conn ? 'Edit connection' : 'Set up single sign-on'} onPress={() => setSheet('connection')} disabled={!verified.length && !conn} accessibilityLabel="Set up or edit single sign-on" />
            {conn ? <Btn small title="Test connection" color={c.violet} loading={busy} onPress={() => run(() => api.post(`/organisations/${o.id}/identity/sso/test`), (r) => (r.ok ? 'Connection looks good' : 'The test failed - see the message'))} /> : null}
            {conn && !live ? <Btn small title="Turn on" color={c.mint} ink={c.ink} disabled={!conn.test_ok} onPress={() => run(() => api.post(`/organisations/${o.id}/identity/sso/status`, { status: 'active' }), 'Single sign-on is live')} /> : null}
            {live ? <Btn small title="Turn off" color={c.orange} onPress={() => run(() => api.post(`/organisations/${o.id}/identity/sso/status`, { status: 'draft' }), 'Single sign-on is off - memberships are kept')} /> : null}
          </View>
        ) : null}
        {!verified.length && !conn && owner ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Verify an email domain first (below).</T> : null}
        {conn && sp ? (
          <View style={{ gap: 10, marginTop: 12 }}>
            <T weight="800">Give these to your identity provider</T>
            {conn.protocol === 'saml' ? (
              <>
                <Copyable label="Sign-in (ACS) URL" value={sp.acs_url} />
                <Copyable label="Entity ID" value={sp.entity_id} />
                {sp.metadata_url !== sp.entity_id ? <Copyable label="Metadata URL" value={sp.metadata_url} /> : null}
              </>
            ) : sp.redirect_uris.map((u) => <Copyable key={u} label="Redirect URI" value={u} />)}
          </View>
        ) : null}
      </Section>

      <Section title="Email domains" color={c.cyan}>
        {domains.length ? domains.map((d) => (
          <View key={d.id} style={{ gap: 6, marginBottom: 8 }}>
            <Row title={d.domain} sub={d.status === 'verified' ? `Verified ${when(d.verified_at)}` : 'Waiting for the DNS record'} right={<Tag label={d.status === 'verified' ? 'Verified' : 'Pending'} color={d.status === 'verified' ? c.mint : c.sun} />} />
            {d.dns_record ? (
              <View style={{ gap: 8, paddingLeft: 4 }}>
                <T size={12} color={c.mute}>Add this TXT record at your DNS provider, then check again. It can take a few minutes to appear.</T>
                <Copyable label="Record name" value={d.dns_record.host} />
                <Copyable label="Record value" value={d.dns_record.value} />
                {owner ? <Btn small title="Check now" loading={busy} onPress={() => run(() => api.post(`/organisations/${o.id}/identity/domains/${d.id}/verify`), (r) => (r.status === 'verified' ? `${r.domain} is verified` : 'Not found yet - DNS can take a while'))} /> : null}
              </View>
            ) : null}
            {owner ? <Btn small title="Release domain" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => run(() => api.del(`/organisations/${o.id}/identity/domains/${d.id}`), 'Domain released')} /> : null}
          </View>
        )) : <Empty emoji="🌐" title="No domain claimed" sub="Claim your school or club email domain. Owning a domain never gives anyone a role." />}
        {owner ? <Btn small title="Claim a domain" onPress={() => setSheet('domain')} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
      </Section>

      {conn ? (
        <Section title="Who gets which role" color={c.pink}>
          <T size={13} color={c.mute}>Match a group from your identity provider (or directory) to a role in this organisation. “Block” always wins. Roles outside the ceiling ({conn.allowed_roles.map((r) => ROLE_LABEL[r]).join(', ') || 'none'}) can never be granted, and owner is never granted this way.</T>
          {mappings.length ? mappings.map((m) => (
            <Row key={m.id} title={m.group_value} sub={m.effect === 'deny' ? 'Blocked from this organisation' : `Gets the ${ROLE_LABEL[m.org_role] ?? m.org_role} role`}
              right={owner ? <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => run(() => api.del(`/organisations/${o.id}/identity/sso/mappings/${m.id}`), 'Mapping removed')} /> : null} />
          )) : <Empty emoji="🔀" title="No mappings yet" sub={conn.default_role ? `Everyone gets the ${ROLE_LABEL[conn.default_role]} role.` : 'Without a mapping or default role nobody is given access.'} />}
          {owner ? <Btn small title="Add a mapping" onPress={() => setSheet('mapping')} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
        </Section>
      ) : null}

      {conn ? (
        <Section title="Directory sync (SCIM)" color={c.lime}>
          <T size={13} color={c.mute}>Let your directory add, change and remove people automatically. Removing someone ends their access to this organisation at once; the person and their history are kept.</T>
          <Copyable label="SCIM base URL" value={scim.base_url} />
          {scim.tokens.map((t) => (
            <Row key={t.id} title={t.name} sub={t.revoked_at ? `Revoked ${when(t.revoked_at)}` : `Created ${when(t.created_at)} · last used ${when(t.last_used_at)}`}
              right={owner && !t.revoked_at ? <Btn small title="Revoke" color={c.paper} ink={c.ink} onPress={() => run(() => api.del(`/organisations/${o.id}/identity/scim-tokens/${t.id}`), 'Credential revoked')} /> : <Tag label={t.revoked_at ? 'Revoked' : 'Active'} />} />
          ))}
          {owner ? <Btn small title="Create a credential" onPress={async () => { const r = await run(() => api.post(`/organisations/${o.id}/identity/scim-tokens`, { name: `Directory ${new Date().toISOString().slice(0, 10)}` })); if (r) setToken(r); }} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
        </Section>
      ) : null}

      <Section title="Access review" color={c.sun}>
        {review.error ? <ErrorBox error={review.error} onRetry={review.reload} /> : !review.data ? <Loading /> : review.data.length ? review.data.map((p) => (
          <Row key={p.user_id} title={p.display_name} sub={`${ROLE_LABEL[p.role] ?? (p.role === 'owner' ? 'Owner' : p.role)} · ${SOURCE[p.source]} · last sign-in ${when(p.last_sso_login_at ?? p.last_seen_at)}${p.directory_active === false ? ' · inactive in directory' : ''}`}
            right={owner && p.role !== 'owner' ? <Btn small title="End access" color={c.orange} onPress={() => setConfirm(p)} accessibilityLabel={`End access for ${p.display_name}`} /> : null} />
        )) : <Empty emoji="🧾" title="Nobody yet" sub="People appear here with how they got access." />}
        <Btn small title="Export access review (CSV)" color={c.paper} ink={c.ink} onPress={exportReview} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      </Section>

      <Section title="Recent sign-in decisions" color={c.violet}>
        {events.error ? <ErrorBox error={events.error} onRetry={events.reload} /> : !events.data ? <Loading /> : events.data.length ? events.data.map((e) => (
          <Row key={e.id} title={`${e.event.replace(/_/g, ' ')}${e.person ? ` · ${e.person}` : ''}`} sub={`${when(e.at)}${e.reason ? ` · ${e.reason.replace(/_/g, ' ')}` : ''}`} right={e.outcome === 'ok' ? null : <Tag label={e.outcome === 'denied' ? 'Refused' : 'Error'} color={c.orange} />} />
        )) : <Empty emoji="📜" title="Nothing yet" sub="Connection changes, sign-ins and refusals are recorded here without any secrets." />}
      </Section>

      <FormSheet visible={sheet === 'domain'} onClose={() => setSheet(null)} title="Claim a domain" submitLabel="Claim"
        fields={[{ key: 'domain', label: 'Email domain', placeholder: 'yourschool.edu.in', hint: 'People with an address on this domain can use your single sign-on. Free providers such as Gmail cannot be claimed.' }]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/identity/domains`, v); reloadAll(); return 'Domain claimed - add the DNS record to verify it'; }} />

      <ConnectionForm visible={sheet === 'connection'} onClose={() => setSheet(null)} o={o} conn={conn} provisionable={provisionable} members={review.data ?? []} onSaved={reloadAll} />

      <FormSheet visible={sheet === 'mapping'} onClose={() => setSheet(null)} title="Add a mapping" submitLabel="Save"
        fields={[
          { key: 'group_value', label: 'Group name', placeholder: 'as your identity provider or directory sends it' },
          { key: 'effect', label: 'What happens', type: 'choice', options: [{ value: 'allow', label: 'Gets a role' }, { value: 'deny', label: 'Blocked' }] },
          { key: 'org_role', label: 'Role', type: 'chips', options: roleOptions(conn?.allowed_roles ?? []), show: (v) => v.effect !== 'deny' },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/identity/sso/mappings`, v.effect === 'deny' ? { group_value: v.group_value, effect: 'deny' } : v); reloadAll(); return 'Mapping saved'; }} />

      <Sheet visible={!!token} onClose={() => setToken(null)} title="Directory credential">
        <View style={{ gap: 10 }}>
          <T size={13} color={c.mute}>Copy this now - it is shown only once. Paste it into your directory as the bearer token.</T>
          {token ? <Copyable label="SCIM token" value={token.token} /> : null}
          <Btn title="Done" onPress={() => setToken(null)} />
        </View>
      </Sheet>

      <Confirm visible={!!confirm} title={`End access for ${confirm?.display_name ?? ''}?`} yes="End access" danger
        body="They lose access to this organisation and are signed out of single sign-on sessions for it. Their account, history and records are kept, and you can invite them again later."
        onClose={() => setConfirm(null)} onYes={async () => { await run(() => api.del(`/organisations/${o.id}/members/${confirm.user_id}`), 'Access ended - history kept'); setConfirm(null); }} />
    </>
  );
}

/** The connection form: the right control for every answer (choices as chips, yes/no as switches, hours as a stepper, people as a pick-list). */
function ConnectionForm({ visible, onClose, o, conn, provisionable, members, onSaved }) {
  const initial = conn ? {
    name: conn.name, protocol: conn.protocol, issuer: conn.config.issuer, client_id: conn.config.client_id, allowed_roles: conn.allowed_roles, default_role: conn.default_role ?? undefined,
    group_claim: conn.group_claim, jit_enabled: conn.jit_enabled, require_mfa_signal: conn.require_mfa_signal, session_hours: conn.session_hours ?? 0, local_login: conn.local_login,
    break_glass_user_ids: conn.break_glass_user_ids, clock_skew_seconds: conn.clock_skew_seconds,
  } : { name: 'Single sign-on', protocol: 'oidc', allowed_roles: ['coach', 'staff'], group_claim: 'groups', jit_enabled: false, session_hours: 0, local_login: 'allowed', clock_skew_seconds: 60 };
  const admins = members.filter((m) => ['owner', 'admin'].includes(m.role)).map((m) => ({ value: m.user_id, label: m.display_name }));
  return (
    <FormSheet visible={visible} onClose={onClose} title={conn ? 'Edit single sign-on' : 'Set up single sign-on'} initial={initial}
      fields={[
        { key: 'name', label: 'Connection name' },
        { key: 'protocol', label: 'Standard', type: 'choice', options: [{ value: 'oidc', label: 'OpenID Connect' }, { value: 'saml', label: 'SAML 2.0' }] },
        { key: 'issuer', label: 'Issuer URL', type: 'url', show: (v) => v.protocol === 'oidc', hint: 'We read the provider’s discovery document from this address.' },
        { key: 'client_id', label: 'Client ID', show: (v) => v.protocol === 'oidc' },
        { key: 'client_secret', label: 'Client secret', type: 'secret', optional: true, show: (v) => v.protocol === 'oidc', hint: conn?.client_secret_set ? 'Leave empty to keep the current secret. It is never shown again.' : 'Stored encrypted and never shown again.' },
        { key: 'idp_metadata_xml', label: 'Identity provider metadata (XML)', type: 'multiline', optional: true, show: (v) => v.protocol === 'saml', hint: 'Paste the metadata file from your provider. It fills the sign-in URL and signing certificates; paste a new one to rotate certificates.' },
        { key: 'sec1', label: 'Who can get in', type: 'section' },
        { key: 'allowed_roles', label: 'Roles this connection may ever grant', type: 'multi', options: roleOptions(provisionable), hint: 'The ceiling: nothing below can grant more. Owner and legal are never available.' },
        { key: 'default_role', label: 'Role for people who match no group', type: 'chips', optional: true, options: (v) => roleOptions(v.allowed_roles ?? []), hint: 'Leave empty to give nobody access without a group mapping.' },
        { key: 'group_claim', label: 'Groups claim name', hint: 'The attribute that carries group names, usually “groups”.' },
        { key: 'jit_enabled', label: 'Create accounts on first sign-in', type: 'switch', hint: 'People with an address on a verified domain get an account and role when they first sign in. Off = only people your directory has added.' },
        { key: 'sec2', label: 'Sessions and sign-in rules', type: 'section' },
        { key: 'session_hours', label: 'Longest session (hours, 0 = standard)', type: 'stepper', min: 0, max: 720, step: 1, suffix: ' h' },
        { key: 'require_mfa_signal', label: 'Require multi-factor from the provider', type: 'switch', hint: 'Refuses sign-ins where your provider did not report multi-factor authentication. We do not check device compliance.' },
        { key: 'local_login', label: 'Passwords for provisioned people', type: 'choice', options: [{ value: 'allowed', label: 'Allowed' }, { value: 'sso_required', label: 'SSO only' }] },
        { key: 'break_glass_user_ids', label: 'Emergency owners/admins (up to 2)', type: 'multi', optional: true, options: admins, show: (v) => v.local_login === 'sso_required', hint: 'These people can still use a password if your provider is down. Their use is logged.' },
        { key: 'clock_skew_seconds', label: 'Clock tolerance (seconds)', type: 'stepper', min: 0, max: 300, step: 15, suffix: ' s' },
      ]}
      onSubmit={async (v) => {
        const body = { name: v.name, protocol: v.protocol, allowed_roles: v.allowed_roles, default_role: v.default_role ?? null, group_claim: v.group_claim, jit_enabled: v.jit_enabled, require_mfa_signal: v.require_mfa_signal,
          session_hours: v.session_hours > 0 ? v.session_hours : null, local_login: v.local_login, clock_skew_seconds: v.clock_skew_seconds, break_glass_user_ids: v.local_login === 'sso_required' ? (v.break_glass_user_ids ?? []).slice(0, 2) : [] };
        if (v.protocol === 'oidc') body.oidc = { issuer: v.issuer, client_id: v.client_id, ...(v.client_secret ? { client_secret: v.client_secret } : {}) };
        else body.saml = v.idp_metadata_xml ? { idp_metadata_xml: v.idp_metadata_xml } : {};
        await api.post(`/organisations/${o.id}/identity/sso`, body);
        onSaved();
        return 'Saved - run a test before turning it on';
      }} />
  );
}

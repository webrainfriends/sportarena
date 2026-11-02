// Platform review of new organisations and academies (platform admin only; the server enforces it). Approve, reject or suspend with a reason the owner
// sees. Nothing is deleted: a rejected or suspended organisation is read-only and leaves public search, and approving restores it. The panel also shows
// which organisation limits (academies, teams, staff seats) are defined in a published plan, because an undefined limit refuses creation.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Empty, ErrorBox, Loading, Row, Seg, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c } from '../theme';
import { explain } from '../access';

const STATUSES = ['pending', 'suspended', 'rejected'];

export function OrgReviews() {
  const { toast } = useSession();
  const [status, setStatus] = useState('pending');
  const [ask, setAsk] = useState(null); // { org, decision }
  const list = useLoad(() => api.get('/admin/commercial/organisation-reviews', { status }), [status]);
  const ready = useLoad(() => api.get('/admin/commercial/enforcement-readiness').catch(() => null), []);
  const label = { pending: t('rv.s.pending'), suspended: t('op.suspended'), rejected: t('op.rejected') };
  const decide = async (org, decision, note) => {
    try { await api.post(`/admin/commercial/organisations/${org.id}/decision`, { decision, note: note || undefined }); toast(t(`rv.${decision}`)); list.reload(); }
    catch (e) { toast(explain(e)); }
  };
  const missing = (ready.data?.keys ?? []).filter((k) => !k.defined).map((k) => k.key.replace(/_/g, ' '));
  return (
    <View style={{ gap: 10 }}>
      <View accessible style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: missing.length ? c.sun : c.lime, backgroundColor: c.paper }}>
        <T size={13} color={missing.length ? c.sun : c.lime} weight="700">{missing.length ? t('rv.missing', { keys: missing.join(', ') }) : t('rv.ready')}</T>
      </View>
      <Seg options={STATUSES.map((value) => ({ value, label: label[value] }))} value={status} onChange={setStatus} />
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : (
        <Section title={t('rv.tab')} color={c.violet}>
          {list.data.length ? list.data.map((o) => (
            <Row key={o.id} title={o.name} sub={[o.kind, o.parent_name, o.owner_name, o.city].filter(Boolean).join(' · ')}
              right={<View style={{ gap: 6 }}>
                <Tag label={label[o.approval_status] ?? o.approval_status} />
                <Btn small title={t('rv.approve')} onPress={() => decide(o, 'approve')} accessibilityLabel={[t('rv.approve'), o.name].join(': ')} />
                {status === 'pending' ? <Btn small title={t('rv.reject')} color={c.paper} ink={c.ink} onPress={() => setAsk({ org: o, decision: 'reject' })} accessibilityLabel={[t('rv.reject'), o.name].join(': ')} /> : null}
                {status !== 'suspended' ? <Btn small title={t('rv.suspend')} color={c.orange} onPress={() => setAsk({ org: o, decision: 'suspend' })} accessibilityLabel={[t('rv.suspend'), o.name].join(': ')} /> : null}
              </View>} />
          )) : <Empty emoji="✅" title={t('rv.empty')} />}
        </Section>
      )}
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? `${t(`rv.${ask.decision}`)}: ${ask.org.name}` : ''} initial={{}}
        fields={[{ key: 'note', label: t('rv.reason'), type: 'multiline' }]}
        onSubmit={async (v) => { await decide(ask.org, ask.decision, v.note); setAsk(null); return null; }} />
    </View>
  );
}

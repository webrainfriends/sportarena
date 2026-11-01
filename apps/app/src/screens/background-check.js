// Federation extras (#703): ordering and reading a background check from a linked provider, inside the existing Compliance screens (no second flow).
// Consent comes first; only the result (clear / not clear / pending) and the provider's reference are kept, never the report; a reviewer still confirms.
// The server enforces consent, access and audit: this only shows what it returns. Same on iOS, iPadOS, Android and web.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, Loading, Sheet, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { SwitchRow } from '../federation-bits';
import { explain } from '../access';
import { c } from '../theme';
import { locale } from '../locale';
import { t } from '../i18n';

const TONE = { clear: c.mint, not_clear: c.red, pending: c.cyan };
const stateLabel = (s) => t(`fedx.bgc.state.${s}`);
const when = (iso) => new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Where a check stands, as the provider reported it and as a reviewer confirmed it. Opening it is an audited read. */
export function CheckStatus({ recordId }) {
  const s = useLoad(() => api.get(`/compliance/records/${recordId}/background-check`), [recordId]);
  if (s.error) return <Empty emoji="🔒" title={explain(s.error)} />;
  if (!s.data) return <Loading />;
  const d = s.data;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Tag label={stateLabel(d.state)} color={TONE[d.state] ?? c.violetSoft} />
        {d.confirmed ? <Tag label={t('fedx.bgc.confirmed')} color={c.mint} /> : null}
      </View>
      {d.awaiting_review ? <T size={14}>{t('fedx.bgc.awaiting')}</T> : null}
      <T size={12} color={c.mute}>{t('fedx.bgc.provider')}: {d.provider} · {d.state_changed_at ? t('fedx.bgc.changedAt', { time: when(d.state_changed_at) }) : t('fedx.bgc.startedAt', { time: when(d.started_at) })}</T>
      <T size={12} color={c.mute}>{t('fedx.bgc.noReport')}</T>
    </View>
  );
}

/** Reviewer's view of one check's provider result (from the review queue). */
export function CheckResultSheet({ recordId, onClose }) {
  return (
    <Sheet visible={!!recordId} onClose={onClose} title={t('fedx.bgc.resultTitle')}>
      {recordId ? <CheckStatus recordId={recordId} /> : null}
    </Sheet>
  );
}

/** The person's (or guardian's) side: consent, order, status. */
export function BackgroundCheckSheet({ item, subject, onClose, onDone }) {
  const { toast } = useSession();
  const reqId = item?.requirement_id;
  const opts = useLoad(() => (reqId ? api.get('/compliance/background-checks/options', { requirement_id: reqId, subject_id: subject?.id }) : Promise.resolve(null)), [reqId, subject?.id]);
  const [agree, setAgree] = useState(false);
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(null);
  const o = opts.data;
  useEffect(() => { if (o?.providers?.length) setProvider((p) => p || o.providers[0].provider); }, [o]);
  useEffect(() => { setAgree(false); }, [reqId]);
  const run = async (key, fn) => { setBusy(key); try { await fn(); await opts.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const body = { requirement_id: reqId, ...(subject?.id ? { subject_id: subject.id } : {}) };
  const consent = () => run('consent', () => api.post('/compliance/background-checks/consent', { ...body, confirm: true }));
  const withdraw = () => run('withdraw', () => api.post('/compliance/background-checks/consent/withdraw', body));
  const order = () => run('order', async () => { await api.post('/compliance/background-checks', { ...body, ...(provider ? { provider } : {}) }); toast(t('fedx.bgc.ordered')); onDone?.(); });
  return (
    <Sheet visible={!!item} onClose={onClose} title={t('fedx.bgc.title')}>
      {!o && !opts.error ? <Loading /> : null}
      {opts.error ? <Empty emoji="🔒" title={explain(opts.error)} /> : null}
      {o ? (
        <View style={{ gap: 14 }}>
          <T weight="800" size={17}>{o.requirement.name}</T>
          {o.record_id ? <CheckStatus recordId={o.record_id} /> : !o.providers.length ? <Card color={c.sunSoft} pad={12}><T size={13}>{t('fedx.bgc.noProvider')}</T></Card> : (
            <View style={{ gap: 12 }}>
              <Card color={c.cyanSoft} pad={14}>
                <T weight="700" size={14}>{t('fedx.bgc.consentTitle')}</T>
                <T size={13} style={{ marginTop: 4 }}>{t('fedx.bgc.consentBody')}</T>
                {subject?.id ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('fedx.bgc.guardianNote')}</T> : null}
              </Card>
              {o.consent ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <Tag label={t('fedx.bgc.consentGiven')} color={c.mint} />
                  <Btn small color={c.paper} ink={c.ink} title={t('fedx.bgc.consentWithdraw')} loading={busy === 'withdraw'} onPress={withdraw} accessibilityLabel={t('fedx.bgc.consentWithdraw')} />
                </View>
              ) : (
                <View style={{ gap: 10 }}>
                  <SwitchRow label={t('fedx.bgc.consentSwitch')} value={agree} onChange={setAgree} />
                  <Btn title={t('fedx.bgc.consentGive')} disabled={!agree} loading={busy === 'consent'} onPress={consent} />
                </View>
              )}
              {o.consent ? (
                <View style={{ gap: 10 }}>
                  {o.providers.length > 1 ? <MenuField label={t('fedx.bgc.provider')} value={provider} onChange={setProvider} options={o.providers.map((p) => ({ value: p.provider, label: p.label }))} /> : null}
                  <Btn title={t('fedx.bgc.order')} loading={busy === 'order'} onPress={order} />
                </View>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

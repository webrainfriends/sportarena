import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { EntityPicker } from '../entity-picker';
import { c } from '../theme';
import { explain } from '../access';

// Guardian-authorized youth sponsorship (#307). A young person is never listed to sponsors: a verified guardian names a sponsor,
// then answers the offer, shares results and allows photos/messages as separate permissions. The young person can read but not act.
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Guardian: which sponsors may offer this child something (opened from Family & guardians). */
export function GuardianSponsors({ child, onClose }) {
  const { toast } = useSession();
  const [pick, setPick] = useState([]);
  const [busy, setBusy] = useState(false);
  const list = useLoad(() => (child ? api.get(`/youth/children/${child.id}/sponsors`, { limit: 100 }) : Promise.resolve([])), [child?.id]);
  const dir = useLoad(() => (child ? api.get('/sponsors', { limit: 100 }) : Promise.resolve([])), [child?.id]);
  const run = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); setPick([]); list.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const live = (list.data ?? []).filter((x) => x.status === 'active'), past = (list.data ?? []).filter((x) => x.status !== 'active');
  return (
    <Sheet visible={!!child} onClose={onClose} title={child ? `${child.display_name}'s sponsors` : 'Sponsors'}>
      <T size={13} color={c.mute}>Sponsors cannot find or message {child?.display_name}. Only a sponsor you authorize here can send an offer, and every offer comes to you. Authorizing allows no photos, messages or results sharing — those stay separate permissions.</T>
      <EntityPicker kind="person" noun="sponsor" label="Authorize a sponsor" value={pick} onChange={setPick} options={(dir.data ?? []).map((s) => ({ id: s.id, label: s.name, sub: s.industry, emoji: s.emoji }))} />
      <Btn title="Authorize sponsor" color={c.pink} disabled={!pick.length || busy} onPress={() => run(() => api.post(`/youth/children/${child.id}/sponsors`, { sponsor_id: pick[0].id }), 'Sponsor authorized')} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <>
          {live.length ? live.map((x) => (
            <Card key={x.id} pad={12} color={c.paper}>
              <T weight="800">{x.sponsor_emoji} {x.sponsor_name}</T>
              <T size={12} color={c.mute}>Authorized {day(x.created_at)} · {x.agreements} agreement{x.agreements === 1 ? '' : 's'}</T>
              <Btn small title="Withdraw" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 6 }} disabled={busy}
                onPress={() => run(() => api.del(`/youth/children/${child.id}/sponsors/${x.sponsor_id}`), 'Authority withdrawn — future sponsor actions are blocked')} />
            </Card>))
            : <Empty emoji="🛡️" title="No sponsor is authorized yet" sub={child ? `${child.display_name} stays hidden from all sponsors.` : 'They stay hidden from all sponsors.'} />}
          {past.map((x) => <T key={x.id} size={12} color={c.mute}>{x.sponsor_name} · withdrawn {day(x.withdrawn_at)} · {x.agreements} agreement{x.agreements === 1 ? '' : 's'} kept</T>)}
        </>)}
    </Sheet>
  );
}

/** Sponsor: young athletes whose guardian authorized this brand. Only a display name is shown. */
export function YouthAuthorizations({ brands, onOffer }) {
  const list = useLoad(async () => (await Promise.all(brands.map(async (b) => (await api.get(`/sponsors/${b.id}/youth-authorizations`, { limit: 50 }).catch(() => [])).map((x) => ({ ...x, brand: b.name }))))).flat(), [brands.map((b) => b.id).join()]);
  if (!list.data?.length) return null;
  return (
    <Section title="Guardian-authorized athletes" color={c.mint}>
      {list.data.map((a) => (
        <Row key={a.id} title={a.display_name} sub={`${a.brand} · authorized by a guardian ${day(a.created_at)}. Offers go to the guardian.`} right={<Btn small title="Send offer" onPress={() => onOffer({ id: a.athlete_id, display_name: a.display_name })} />} />
      ))}
    </Section>
  );
}

/** On the agreement: who decides for the young person, and the guardian's separate permissions. */
export function YouthPanel({ deal, reload }) {
  const { toast } = useSession();
  const y = deal.youth;
  const [busy, setBusy] = useState(false);
  if (!y) return null;
  const toggle = async (purpose, on) => {
    setBusy(true);
    try { await (on ? api.post(`/youth/children/${deal.target_id}/consents`, { purpose }) : api.del(`/youth/children/${deal.target_id}/consents/${purpose}`)); toast(on ? 'Permission saved' : 'Permission withdrawn'); reload(); } catch (e) { toast(explain(e)); reload(); } finally { setBusy(false); }
  };
  const setPayee = async (guardianId) => {
    setBusy(true);
    try { await api.post(`/sponsorships/${deal.id}/youth-payee`, { guardian_id: guardianId }); toast('Payee saved'); reload(); } catch (e) { toast(explain(e)); reload(); } finally { setBusy(false); }
  };
  const Row2 = ({ title, sub, value, onChange, disabled }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1 }}><T weight="800">{title}</T><T size={12} color={c.mute}>{sub}</T></View>
      <Switch value={value} disabled={disabled || busy} onValueChange={onChange} accessibilityRole="switch" accessibilityLabel={title} />
    </View>);
  return (
    <>
      <Card color={c.cyanSoft}>
        <T weight="800" accessibilityRole="header">🛡 This athlete is under the age of independence</T>
        <T size={13}>{y.minor_self ? 'Your guardian manages this sponsorship. You can read it, but accepting, sharing results and confirming payments are done by them.'
          : y.guardian_acting ? 'You decide for them as their verified guardian. Accepting the agreement does not allow photos, videos, messages or results sharing — those are separate permissions below.'
            : 'A verified guardian decides for them. Their results, contact and health details are never shown here, and nothing is shared unless the guardian allows it.'}</T>
        {!y.authority_live && deal.role === 'sponsor' ? <Tag label="Guardian authority withdrawn — new actions are blocked" color={c.redSoft} /> : null}
      </Card>
      {y.guardian_acting ? (
        <Section title="Permissions for this agreement" color={c.mint}>
          <Card>
            <View style={{ gap: 16 }}>
            <Row2 title="Photos & videos" sub="Needed before any endorsement content can be submitted." value={y.media_allowed} onChange={(on) => toggle('media', on)} />
            <Row2 title="Sponsor messages" sub="Lets the sponsor write notes, reviews and objectives. They come to you, not to your child." value={y.contact_allowed} onChange={(on) => toggle('contact', on)} />
            <View accessibilityRole="summary" style={{ gap: 6 }}>
              <T weight="800">Who is paid</T>
              <T size={12} color={c.mute}>Sponsorship money is paid to a verified guardian and never to the young person. It applies to payments from now on; payments already open keep their payee.</T>
              {!y.payee_set ? <Tag label="No guardian is set to receive the money yet — the sponsor cannot pay" color={c.sunSoft} /> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {(y.guardians ?? []).map((g) => (
                  <Btn key={g.id} small title={g.payee ? `✓ ${g.name}` : g.name} color={g.payee ? c.mint : c.paper} ink={g.payee ? c.ink : c.ink} disabled={busy || g.payee}
                    accessibilityLabel={g.payee ? `${g.name} is paid` : `Pay ${g.name}`} onPress={() => setPayee(g.id)} />))}
              </View>
            </View>
            <T size={12} color={c.mute}>Sharing results is set under Performance & reviews. Each permission can be withdrawn at any time; payments and history are unaffected.</T>
            </View>
          </Card>
        </Section>) : null}
      {deal.role === 'sponsor' ? <T size={12} color={c.mute}>Results: {y.results_shared ? 'shared by the guardian' : 'not shared'} · Photos & videos: {y.media_allowed ? 'allowed' : 'not allowed'} · Messages: {y.contact_allowed ? 'allowed' : 'not allowed'}</T> : null}
    </>
  );
}

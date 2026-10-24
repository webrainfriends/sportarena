// Families & athletes: a searchable directory and a 360 of one athlete's relationship with the academy
// (who is responsible, applications, enrolments, fees, agreements). Names only; contact details are never shown here.
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, T, Tag } from '../ui';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Block, Fact, Initials, LetterSheet, Split, StageBadge, when } from './academy-ui';

export function Families({ o, onOpenApplication }) {
  const [q, setQ] = useState(''), [status, setStatus] = useState(null), [open, setOpen] = useState(null);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/athletes`, { q: q.trim() || undefined, status: status || undefined, limit: 100 }), [o.id, q, status]);
  const body = (
    <View style={{ gap: 10 }}>
      <Field value={q} onChangeText={setQ} placeholder="Find an athlete by name or handle…" accessibilityLabel="Search athletes" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {[[null, 'Everyone'], ['enrolled', 'Enrolled'], ['applicant', 'Applying'], ['former', 'Former']].map(([k, l]) => <Chip key={l} label={l} active={status === k} onPress={() => setStatus(k)} />)}
      </ScrollView>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((a) => (
        <Row key={a.athlete_id} left={<Initials user={a} size={40} />} title={a.display_name} sub={`${(a.programmes ?? []).join(', ') || 'No open programmes'}${a.via_guardian ? ' · guardian-managed' : ''}`}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{a.enrolled ? <Tag label={`${a.enrolled} enrolled`} color={c.lime} /> : a.open_applications ? <Tag label="Applying" /> : <Tag label="Former" />}{a.overdue ? <Tag label={`${a.overdue} overdue`} color={c.orangeSoft} /> : null}</View>} onPress={() => setOpen(a.athlete_id)} />
      )) : <Empty emoji="👨‍👩‍👧" title="No one here yet" sub="Athletes and their guardians appear once they enquire, apply or enrol." />}
    </View>
  );
  return <Split open={!!open} onClose={() => setOpen(null)} detailTitle="Athlete" list={body} detail={open ? <Athlete o={o} id={open} onOpenApplication={onOpenApplication} /> : null} />;
}

function Athlete({ o, id, onOpenApplication }) {
  const a = useLoad(() => api.get(`/organisations/${o.id}/academy/athletes/${id}`), [o.id, id]);
  const { toast } = useSession();
  const [letter, setLetter] = useState(null);
  if (a.error) return <ErrorBox error={a.error} onRetry={a.reload} />;
  if (!a.data) return <Loading />;
  const d = a.data;
  const due = d.charges.filter((x) => x.status === 'awaiting_payment');
  return (
    <View style={{ gap: 10 }}>
      <LetterSheet enrolment={letter} orgId={o.id} onClose={() => setLetter(null)} toast={toast} />
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Initials user={d.athlete} size={48} /><View style={{ flex: 1 }}><T weight="800" size={18}>{d.athlete.display_name}</T><T size={12} color={c.mute}>@{d.athlete.handle}{d.is_youth ? ' · young person' : ''}</T></View></View>
      {d.is_youth ? (
        <Block title="Responsible adults">
          {d.responsible.length ? d.responsible.map((g) => <T key={g.id} size={14}>👤 {g.display_name} <T size={12} color={c.mute}>@{g.handle} · verified guardian</T></T>) : <T size={13} color={c.mute}>No verified guardian on record.</T>}
          <T size={11} color={c.mute}>Contact is made through the app. Their details are not copied into the academy.</T>
        </Block>
      ) : null}
      <Block title="Enrolments">
        {d.enrolments.length ? d.enrolments.map((e) => <Row key={e.id} title={e.programme} sub={`${e.group_name} · since ${when(e.enrolled_at)}${e.version ? ` · terms v${e.version}` : ''}${e.ended_reason ? ` · ${e.ended_reason}` : ''}`} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={e.status} color={e.status === 'enrolled' ? c.lime : undefined} />{['enrolled', 'paused', 'completed', 'graduated'].includes(e.status) ? <Btn small title="Letter" color={c.paper} ink={c.ink} onPress={() => setLetter({ enrolment_id: e.id, display_name: d.athlete?.display_name ?? '' })} /> : null}</View>} />) : <T size={13} color={c.mute}>Not enrolled.</T>}
      </Block>
      <Block title="Applications">
        {d.applications.length ? d.applications.map((x) => <Row key={x.id} title={x.programme} sub={`started ${when(x.created_at)}${x.applicant_name !== d.athlete.display_name ? ` · by ${x.applicant_name}` : ''}`} right={<StageBadge stage={x.stage} />} onPress={() => onOpenApplication?.(x.id)} />) : <T size={13} color={c.mute}>None.</T>}
      </Block>
      <Block title="Fees">
        {due.length ? <T size={13} weight="700">{due.length} unpaid · {due.some((x) => x.overdue) ? 'some overdue' : 'none overdue'}</T> : null}
        {d.charges.length ? d.charges.map((x) => <Row key={x.id} title={`${x.kind} · ${moneyIn(x.amount_minor, x.currency)}`} sub={`due ${when(x.due_on)}${x.funded_minor > 0 ? ` · ${moneyIn(x.funded_minor, x.currency)} ${x.funding_source}-funded` : ''}${x.discount_minor > 0 ? ` · ${moneyIn(x.discount_minor, x.currency)} discount` : ''}${x.paid_at ? ` · paid ${when(x.paid_at)}` : ''}`} right={<Tag label={x.overdue ? 'Overdue' : x.status.replace('_', ' ')} color={x.overdue ? c.orangeSoft : x.status === 'paid' ? c.lime : undefined} />} />) : <T size={13} color={c.mute}>No fees.</T>}
      </Block>
      <Block title="Agreements">
        {d.agreements.length ? d.agreements.map((g, i) => <Fact key={i} k={`${g.title} v${g.version}`} v={`${when(g.created_at)} · ${g.acknowledged_by}${g.as_guardian ? ' (guardian)' : ''}`} />) : <T size={13} color={c.mute}>Nothing acknowledged yet.</T>}
      </Block>
      <T size={11} color={c.mute}>Health information is not part of the academy record. Viewing this page is logged.</T>
    </View>
  );
}

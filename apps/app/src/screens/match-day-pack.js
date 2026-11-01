// The referee's match-day pack, on Officials home: save the games you may score so the live console keeps working with no signal.
// It is the same Match Centre and the same capabilities, not a second scorer: this card only downloads the games and the heats, finals and
// field flights (get_scorer_pack), lists what is kept on the device and how many taps are waiting to be sent for each. A saved heat opens in
// the same session pad the event console uses, on its own screen. Everything is encrypted on the device and removed at sign-out.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Section, T, Tag } from '../ui';
import { explain } from '../access';
import { c } from '../theme';
import { downloadPack, listSaved, listSavedSessions } from '../scorer/pack';
import { waitingCount } from '../scorer/queue';

const clock = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function MatchDayPack() {
  const { user, toast } = useSession();
  const { push: go } = useNav();
  const [rows, setRows] = useState(null);
  const [heats, setHeats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    const list = await listSaved(user.id);
    const withWaiting = await Promise.all(list.map(async (d) => ({ ...d, waiting: await waitingCount(`sa_queue_fx_${d.game.fixture.id}`) })));
    setRows(withWaiting.sort((a, b) => String(a.game.fixture.scheduled_at).localeCompare(String(b.game.fixture.scheduled_at))));
    const sess = await listSavedSessions(user.id);
    setHeats((await Promise.all(sess.map(async (d) => ({ ...d, waiting: await waitingCount(`sa_queue_ss_${d.session.session.id}`) })))).sort((a, b) => String(a.session.session.scheduled_at).localeCompare(String(b.session.session.scheduled_at))));
  }, [user.id]);

  const save = useCallback(async (quiet) => {
    setBusy(true);
    try {
      const r = await downloadPack(user.id);
      const total = r.games.length + (r.sessions?.length ?? 0);
      setNote(total ? null : 'No games or heats to score in the next 36 hours.');
      if (!quiet) toast(total ? `${total} game${total === 1 ? '' : 's'} and heats saved for scoring with no signal.` : 'Nothing to save yet.');
    } catch (e) { if (!quiet) toast(explain(e)); } finally { setBusy(false); await load(); }
  }, [user.id, toast, load]);

  // games already saved on this device are kept current whenever the official opens their home while online
  useEffect(() => { load().then(() => Promise.all([listSaved(user.id), listSavedSessions(user.id)])).then(([l, h]) => { if (l.length || h.length) save(true); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section title="Match-day pack" color={c.mint}>
      <Card pad={14}>
        <View style={{ gap: 10 }}>
          <T size={13.5} color={c.mute}>Save today's games and heats on this device to keep scoring when the signal drops. Taps are checked against the sport's rules here, kept encrypted, and sent in order when you are back online.</T>
          <Btn title={busy ? 'Saving…' : rows?.length ? 'Refresh saved games' : 'Save my games for offline'} loading={busy} onPress={() => save(false)} style={{ minHeight: 48 }} accessibilityLabel="Save my games for scoring with no signal" />
          {note ? <T size={13} color={c.mute}>{note}</T> : null}
          {rows?.length ? rows.map((d) => {
            const f = d.game.fixture;
            return (
              <Card key={d.id} pad={12} onPress={() => go('MatchCentre', { id: f.id })} accessibilityLabel={`${f.home?.name ?? 'TBD'} versus ${f.away?.name ?? 'TBD'}, saved ${clock(d.saved_at)}${d.waiting ? `, ${d.waiting} taps waiting to be sent` : ''}`}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <Tag label="✓ Saved offline" color={c.mintSoft} />
                    {d.waiting ? <Tag label={`${d.waiting} waiting to send`} color={c.sunSoft} /> : null}
                    {d.game.fixture.status !== 'scheduled' ? <Tag label={d.game.fixture.status === 'live' ? 'Live' : d.game.fixture.status} color={c.violetSoft} /> : null}
                  </View>
                  <T weight="800" size={16}>{f.home?.name ?? 'TBD'} v {f.away?.name ?? 'TBD'}</T>
                  <T size={12.5} color={c.mute}>{f.event_name}{f.round ? ` · ${f.round}` : ''} · {clock(f.scheduled_at)}</T>
                  <T size={12} color={c.mute}>Saved {clock(d.saved_at)} · {d.game.ruleset.label ?? d.game.ruleset.kind}</T>
                </View>
              </Card>
            );
          }) : rows && !heats.length ? <T size={13} color={c.mute}>Nothing saved on this device yet.</T> : null}
          {heats.map((d) => {
            const x = d.session;
            return (
              <Card key={d.id} pad={12} onPress={() => go('SessionPad', { id: x.session.id })} accessibilityLabel={`${x.session.discipline} ${x.session.label}, saved ${clock(d.saved_at)}${d.waiting ? `, ${d.waiting} entries waiting to be sent` : ''}`}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <Tag label="✓ Saved offline" color={c.mintSoft} />
                    {d.waiting ? <Tag label={`${d.waiting} waiting to send`} color={c.sunSoft} /> : null}
                    <Tag label="Heat / flight" color={c.violetSoft} />
                  </View>
                  <T weight="800" size={16}>{x.session.discipline} · {x.session.label}</T>
                  <T size={12.5} color={c.mute}>{clock(x.session.scheduled_at)} · {x.projection.entries.length} competitor{x.projection.entries.length === 1 ? '' : 's'}</T>
                </View>
              </Card>
            );
          })}
        </View>
      </Card>
    </Section>
  );
}

// Federation extras (#703): the optional census information a person chooses to give (today: gender). Held only if given, encrypted, counted only in totals of
// five or more, withdrawable at any time; a guardian gives it for a young person. Reached from the account sheet; the server enforces who may read or change it.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';
import { Btn, Card, Chip, Loading, Sheet, T } from './ui';
import { explain } from './access';
import { c } from './theme';
import { t } from './i18n';

const GENDERS = ['female', 'male', 'non_binary', 'self_described'];

export function CensusInfoSheet({ visible, onClose, userId }) {
  const { toast } = useSession();
  const q = useLoad(() => (visible ? api.get('/demographics', userId ? { user_id: userId } : {}) : Promise.resolve(null)), [visible, userId]);
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(null);
  const d = q.data;
  useEffect(() => { if (d) setPick(d.gender ?? null); }, [d]);
  const run = async (key, fn) => { setBusy(key); try { await fn(); await q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  const save = () => run('save', async () => { await api.post('/demographics', { ...(userId ? { user_id: userId } : {}), gender: pick, consent: true }); toast(t('fedx.demo.saved')); });
  const withdraw = () => run('withdraw', async () => { await api.del('/demographics', userId ? { user_id: userId } : {}); setPick(null); toast(t('fedx.demo.withdrawn')); });
  return (
    <Sheet visible={visible} onClose={onClose} title={t('fedx.demo.title')}>
      {!d && !q.error ? <Loading /> : null}
      {q.error ? <T color={c.red}>{explain(q.error)}</T> : null}
      {d ? (
        <View style={{ gap: 14 }}>
          <Card color={c.cyanSoft} pad={14}><T size={13}>{t('fedx.demo.body')}</T></Card>
          <View style={{ gap: 8 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('fedx.demo.gender').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {GENDERS.map((g) => <Chip key={g} label={t(`fedx.demo.g.${g}`)} active={pick === g} onPress={() => setPick(g)} />)}
            </View>
          </View>
          <T size={12} color={c.mute}>{d.held ? t('fedx.demo.held') : t('fedx.demo.none')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Btn title={t('fedx.demo.save')} disabled={!pick || (d.held && pick === d.gender)} loading={busy === 'save'} onPress={save} />
            {d.held ? <Btn color={c.paper} ink={c.red} title={t('fedx.demo.withdraw')} loading={busy === 'withdraw'} onPress={withdraw} accessibilityLabel={t('fedx.demo.withdraw')} /> : null}
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

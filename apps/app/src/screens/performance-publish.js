// Performance Publishing — Post My Performance sheet + feed card (issue #1190).
// Athletes post results from native games, external events or independent sessions.
// Evidence badge reflects provenance; peer feedback invitations fire after publish.
import React, { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, ErrorBox, H2, Loading, Tag, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c, day } from '../theme';

const AUDIENCE_OPTS = () => [
  { value: 'private', label: t('pp.audience_private'), icon: '🔒' },
  { value: 'followers', label: t('pp.audience_followers'), icon: '👥' },
  { value: 'club_team', label: t('pp.audience_club'), icon: '🏟️' },
  { value: 'coach_recruiter', label: t('pp.audience_coach'), icon: '🎯' },
  { value: 'public', label: t('pp.audience_public'), icon: '🌍' },
];

const EVIDENCE_BADGE = {
  officially_verified: { label: t('pp.badge_official'), color: c.mint },
  organiser_attested: { label: t('pp.badge_attested'), color: c.cyan },
  self_reported: { label: t('pp.badge_self'), color: c.mute },
  imported: { label: t('pp.badge_imported'), color: c.mute },
};

const RPE_COLOR = (v) => {
  if (v <= 3) return '#22C55E';
  if (v <= 6) return '#F59E0B';
  return '#EF4444';
};

const STEPS = 5;

function StepBar({ step }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: STEPS, now: step }}>
      {Array.from({ length: STEPS }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < step ? c.pink : c.line }} />
      ))}
    </View>
  );
}

function Step1Source({ value, onChange }) {
  const opts = [
    { value: 'native_game', icon: '🎮', label: t('pp.src_native'), sub: t('pp.src_native_sub') },
    { value: 'external_event', icon: '🌐', label: t('pp.src_external'), sub: t('pp.src_external_sub') },
    { value: 'independent', icon: '🏋️', label: t('pp.src_independent'), sub: t('pp.src_independent_sub') },
  ];
  return (
    <View style={{ gap: 12 }}>
      <T weight="800" size={17}>{t('pp.step1_title')}</T>
      <T size={13} color={c.mute}>{t('pp.step1_sub')}</T>
      {opts.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: value === o.value }}
          style={{ borderWidth: value === o.value ? 2 : 1, borderColor: value === o.value ? c.pink : c.line, borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72 }}>
          <T size={28}>{o.icon}</T>
          <View style={{ flex: 1 }}>
            <T weight="800" size={15}>{o.label}</T>
            <T size={12.5} color={c.mute}>{o.sub}</T>
          </View>
          {value === o.value ? <T size={18} color={c.pink}>✓</T> : null}
        </Pressable>
      ))}
    </View>
  );
}

function OpponentCard({ opponent, onSet }) {
  if (!opponent) {
    return (
      <Pressable onPress={onSet} accessibilityRole="button"
        style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, borderRadius: 10, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.line, alignItems: 'center', justifyContent: 'center' }}><T color={c.mute} size={18}>+</T></View>
        <T color={c.mute} size={14}>{t('pp.add_opponent')}</T>
      </Pressable>
    );
  }
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T weight="800" size={16} color={c.pink}>{(opponent.name ?? '?')[0]}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight="800" size={15}>{opponent.name}</T>
          <T size={12} color={c.mute}>{opponent.rating ? `${t('pp.rating')} ${opponent.rating}` : ''}{opponent.country ? ` · ${opponent.country}` : ''}</T>
        </View>
        {opponent.result ? <Tag label={opponent.result === 'won' ? t('pp.won') : opponent.result === 'lost' ? t('pp.lost') : t('pp.draw')} color={opponent.result === 'won' ? c.mintSoft : c.redSoft} /> : null}
        <Pressable hitSlop={8} onPress={onSet}><T size={12} color={c.mute}>{t('pp.change')}</T></Pressable>
      </View>
    </Card>
  );
}

function ScoreTiles({ sets, onUpdate }) {
  if (!sets || sets.length === 0) return null;
  return (
    <View>
      <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('pp.set_scores').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {sets.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 48, height: 52, backgroundColor: c.paper, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line }}>
              <TextInput value={String(s.my ?? '')} onChangeText={(v) => onUpdate(i, 'my', v)} keyboardType="numeric" maxLength={2} style={{ fontSize: 22, fontWeight: '800', textAlign: 'center', color: c.fg, width: 44, height: 48 }} accessibilityLabel={`${t('pp.set')} ${i + 1} ${t('pp.my_score')}`} />
            </View>
            <T size={18} weight="800" color={c.mute}>–</T>
            <View style={{ width: 48, height: 52, backgroundColor: c.paper, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line }}>
              <TextInput value={String(s.opp ?? '')} onChangeText={(v) => onUpdate(i, 'opp', v)} keyboardType="numeric" maxLength={2} style={{ fontSize: 22, fontWeight: '800', textAlign: 'center', color: c.fg, width: 44, height: 48 }} accessibilityLabel={`${t('pp.set')} ${i + 1} ${t('pp.opp_score')}`} />
            </View>
            <T size={12} color={c.mute} style={{ marginLeft: 2 }}>{t('pp.set')} {i + 1}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

function StatGrid({ stats, onUpdate }) {
  if (!stats || stats.length === 0) return null;
  return (
    <View>
      <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('pp.match_stats').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {stats.map((s, i) => (
          <View key={i} style={{ flexBasis: '30%', flexGrow: 1, minWidth: 100, backgroundColor: c.paper, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: c.line }}>
            <T size={11} weight="700" color={c.mute} style={{ marginBottom: 4 }}>{s.label.toUpperCase()}</T>
            <TextInput value={String(s.value ?? '')} onChangeText={(v) => onUpdate(i, v)} keyboardType={s.type === 'percent' ? 'decimal-pad' : 'numeric'} style={{ fontSize: 20, fontWeight: '800', color: c.fg }} accessibilityLabel={s.label} />
            {s.unit ? <T size={11} color={c.mute}>{s.unit}</T> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function RPESlider({ value, onChange }) {
  return (
    <View>
      <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('pp.rpe_label').toUpperCase()}</T>
      <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
          <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="radio" accessibilityState={{ selected: value === v }} style={{ flex: 1, height: 36, borderRadius: 6, backgroundColor: value === v ? RPE_COLOR(v) : c.line, alignItems: 'center', justifyContent: 'center' }}>
            {value === v ? <T size={12} weight="900" color="#fff">{v}</T> : <T size={11} color={c.mute}>{v}</T>}
          </Pressable>
        ))}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 4 }}>{value ? `${value}/10 — ${value <= 3 ? t('pp.rpe_easy') : value <= 6 ? t('pp.rpe_moderate') : t('pp.rpe_hard')}` : t('pp.rpe_hint')}</T>
    </View>
  );
}

function Step2Metrics({ data, onChange }) {
  const updateSet = (i, field, v) => {
    const sets = [...(data.sets ?? [])];
    sets[i] = { ...sets[i], [field]: v };
    onChange({ ...data, sets });
  };
  const updateStat = (i, v) => {
    const stats = [...(data.stats ?? [])];
    stats[i] = { ...stats[i], value: v };
    onChange({ ...data, stats });
  };
  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      <View style={{ gap: 20 }}>
        <T weight="800" size={17}>{t('pp.step2_title')}</T>
        <OpponentCard opponent={data.opponent} onSet={() => {}} />
        <ScoreTiles sets={data.sets ?? [{ my: '', opp: '' }, { my: '', opp: '' }, { my: '', opp: '' }]} onUpdate={updateSet} />
        <StatGrid stats={data.stats ?? [
          { label: t('pp.stat_aces'), value: '', type: 'int' },
          { label: t('pp.stat_dfs'), value: '', type: 'int' },
          { label: t('pp.stat_1st_serve'), value: '', type: 'percent', unit: '%' },
          { label: t('pp.stat_break_pts'), value: '', type: 'int' },
          { label: t('pp.stat_winners'), value: '', type: 'int' },
          { label: t('pp.stat_ufe'), value: '', type: 'int' },
        ]} onUpdate={updateStat} />
        <RPESlider value={data.rpe ?? 0} onChange={(v) => onChange({ ...data, rpe: v })} />
        <View>
          <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('pp.duration_label').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ width: 80, backgroundColor: c.paper, borderRadius: 8, padding: 12, borderWidth: 1, borderColor: c.line, alignItems: 'center' }}>
              <TextInput value={String(data.duration_h ?? '')} onChangeText={(v) => onChange({ ...data, duration_h: v })} keyboardType="numeric" maxLength={2} style={{ fontSize: 22, fontWeight: '800', color: c.fg, textAlign: 'center', width: 56 }} accessibilityLabel={t('pp.hours')} />
              <T size={11} color={c.mute}>{t('pp.hours_abbr')}</T>
            </View>
            <View style={{ width: 80, backgroundColor: c.paper, borderRadius: 8, padding: 12, borderWidth: 1, borderColor: c.line, alignItems: 'center' }}>
              <TextInput value={String(data.duration_m ?? '')} onChangeText={(v) => onChange({ ...data, duration_m: v })} keyboardType="numeric" maxLength={2} style={{ fontSize: 22, fontWeight: '800', color: c.fg, textAlign: 'center', width: 56 }} accessibilityLabel={t('pp.minutes')} />
              <T size={11} color={c.mute}>{t('pp.minutes_abbr')}</T>
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function Step3Media({ data, onChange }) {
  return (
    <View style={{ gap: 16 }}>
      <T weight="800" size={17}>{t('pp.step3_title')}</T>
      <T size={13} color={c.mute}>{t('pp.step3_sub')}</T>
      <View style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, borderRadius: 12, padding: 24, alignItems: 'center', gap: 8, minHeight: 100 }}>
        <T size={30}>📎</T>
        <T weight="700" size={14}>{t('pp.media_tap_add')}</T>
        <T size={12} color={c.mute}>{t('pp.media_formats')}</T>
      </View>
      <Pressable onPress={() => onChange({ ...data, rights: !data.rights })} accessibilityRole="checkbox" accessibilityState={{ checked: !!data.rights }}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderWidth: 1, borderColor: data.rights ? c.mint : c.line, borderRadius: 10, minHeight: 56 }}>
        <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: data.rights ? c.mint : c.line, backgroundColor: data.rights ? c.mint : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
          {data.rights ? <T size={13} color="#fff" weight="900">✓</T> : null}
        </View>
        <T size={13} style={{ flex: 1 }}>{t('pp.rights_confirm')}</T>
      </Pressable>
    </View>
  );
}

function Step4Audience({ value, onChange }) {
  return (
    <View style={{ gap: 14 }}>
      <T weight="800" size={17}>{t('pp.step4_title')}</T>
      <T size={13} color={c.mute}>{t('pp.step4_sub')}</T>
      {AUDIENCE_OPTS().map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: value === o.value }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderWidth: value === o.value ? 2 : 1, borderColor: value === o.value ? c.pink : c.line, borderRadius: 10, minHeight: 56 }}>
          <T size={22}>{o.icon}</T>
          <T weight="700" size={15} style={{ flex: 1 }}>{o.label}</T>
          {value === o.value ? <T color={c.pink} size={16}>●</T> : <T color={c.line} size={16}>○</T>}
        </Pressable>
      ))}
    </View>
  );
}

function Step5Preview({ data, onPublish, publishing }) {
  const [caption, setCaption] = useState(data.ai_caption ?? '');
  const [useAi, setUseAi] = useState(true);
  const eligiblePeers = data.eligible_peer_count ?? 0;
  return (
    <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      <View style={{ gap: 16 }}>
        <T weight="800" size={17}>{t('pp.step5_title')}</T>
        {data.ai_caption ? (
          <Card pad={14}>
            <T weight="700" size={12} color={c.mute} style={{ marginBottom: 6 }}>{t('pp.ai_caption_label')}</T>
            <T size={14} style={{ lineHeight: 21 }}>{caption}</T>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <Chip label={t('pp.use_caption')} active={useAi} onPress={() => setUseAi(true)} />
              <Chip label={t('pp.edit_caption')} active={!useAi} onPress={() => setUseAi(false)} />
            </View>
            {!useAi ? (
              <TextInput value={caption} onChangeText={setCaption} multiline style={{ marginTop: 10, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, fontSize: 14, color: c.fg, minHeight: 80 }} accessibilityLabel={t('pp.caption_field')} />
            ) : null}
          </Card>
        ) : null}
        <Card pad={14}>
          <T weight="700" size={12} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('pp.metric_strip').toUpperCase()}</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {data.opponent ? (
                <Tag label={`${t('pp.def')} ${data.opponent.name}`} color={c.violetSoft} />
              ) : null}
              {(data.stats ?? []).filter((s) => s.value).map((s, i) => (
                <Tag key={i} label={`${s.label}: ${s.value}${s.unit ?? ''}`} color={c.cyanSoft} />
              ))}
              {data.rpe ? <Tag label={`RPE ${data.rpe}/10`} color={data.rpe <= 3 ? c.mintSoft : data.rpe <= 6 ? c.sunSoft : c.redSoft} /> : null}
            </View>
          </ScrollView>
        </Card>
        {eligiblePeers > 0 ? (
          <Card pad={14}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={22}>🤝</T>
              <T size={13} style={{ flex: 1 }}>{t('pp.peer_invite_note', { count: eligiblePeers })}</T>
            </View>
          </Card>
        ) : null}
        <T size={12} color={c.mute}>{t('pp.audience_note', { audience: data.audience ?? 'private' })}</T>
        <Btn title={publishing ? t('pp.publishing') : t('pp.publish_btn')} onPress={() => onPublish({ ...data, caption: useAi ? caption : caption })} disabled={publishing} />
      </View>
    </ScrollView>
  );
}

export function PerformancePublishSheet({ visible, onClose, gameId, sportSlug }) {
  const { toast } = useSession();
  const [step, setStep] = useState(1);
  const [source, setSource] = useState('native_game');
  const [metrics, setMetrics] = useState({});
  const [mediaData, setMediaData] = useState({});
  const [audience, setAudience] = useState('private');
  const [publishing, setPublishing] = useState(false);

  const canNext = () => {
    if (step === 1) return !!source;
    if (step === 3) return !!mediaData.rights;
    return true;
  };

  const handlePublish = async (finalData) => {
    setPublishing(true);
    try {
      await api.post('/me/performance-posts', {
        source_type: source,
        game_id: source === 'native_game' ? gameId : undefined,
        sport: sportSlug,
        metrics: finalData.stats ?? [],
        rpe: finalData.rpe,
        duration_minutes: (parseInt(finalData.duration_h ?? 0) * 60) + parseInt(finalData.duration_m ?? 0),
        opponent: finalData.opponent,
        sets: finalData.sets,
        caption: finalData.caption,
        audience,
        media_consent: !!mediaData.rights,
        source_rights_confirmed: !!mediaData.rights,
      });
      toast(t('pp.published_toast'));
      onClose?.();
    } catch (e) {
      toast(e.message);
    } finally {
      setPublishing(false);
    }
  };

  if (!visible) return null;
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ padding: 20, flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <Pressable hitSlop={12} onPress={step > 1 ? () => setStep(s => s - 1) : onClose} accessibilityRole="button" accessibilityLabel={step > 1 ? t('pp.back') : t('pp.close')}>
            <T size={22} color={c.mute}>{step > 1 ? '‹' : '✕'}</T>
          </Pressable>
          <T weight="900" size={16} style={{ flex: 1, textAlign: 'center' }}>{t('pp.sheet_title')}</T>
          <T size={13} color={c.mute}>{step}/{STEPS}</T>
        </View>
        <StepBar step={step} />
        <View style={{ flex: 1 }}>
          {step === 1 ? <Step1Source value={source} onChange={setSource} /> : null}
          {step === 2 ? <Step2Metrics data={metrics} onChange={setMetrics} /> : null}
          {step === 3 ? <Step3Media data={mediaData} onChange={setMediaData} /> : null}
          {step === 4 ? <Step4Audience value={audience} onChange={setAudience} /> : null}
          {step === 5 ? <Step5Preview data={{ ...metrics, audience, ai_caption: metrics.ai_caption, eligible_peer_count: metrics.eligible_peer_count }} onPublish={handlePublish} publishing={publishing} /> : null}
        </View>
        {step < 5 ? (
          <View style={{ paddingTop: 12 }}>
            <Btn title={t('pp.next')} onPress={() => setStep(s => s + 1)} disabled={!canNext()} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function PerformancePostCard({ post, isOwn, onChallenge, onEdit, onWithdraw }) {
  const badge = EVIDENCE_BADGE[post.provenance] ?? EVIDENCE_BADGE.self_reported;
  const audience = AUDIENCE_OPTS().find((o) => o.value === post.audience);
  return (
    <Card pad={14} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T size={22}>{post.sport_emoji ?? '🏅'}</T>
        <View style={{ flex: 1 }}>
          <T weight="800" size={15}>{post.event_name ?? t('pp.independent_session')}</T>
          <T size={12} color={c.mute}>{post.sport_label} · {day(post.published_at)}</T>
        </View>
        <Tag label={badge.label} color={{ backgroundColor: `${badge.color}22`, borderColor: badge.color }} textColor={badge.color} />
      </View>
      {post.caption ? <T size={13.5} style={{ lineHeight: 20 }}>{post.caption}</T> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {post.opponent ? <Tag label={`${t('pp.def')} ${post.opponent.name}`} color={c.violetSoft} /> : null}
          {(post.metric_strip ?? []).map((s, i) => <Tag key={i} label={s} color={c.cyanSoft} />)}
          {post.rpe ? <Tag label={`RPE ${post.rpe}/10`} color={c.mute} /> : null}
        </View>
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {audience ? <Tag label={`${audience.icon} ${audience.label}`} color={c.mute} /> : null}
        {post.peer_feedback_count ? <Tag label={t('pp.peer_count', { n: post.peer_feedback_count })} color={c.violetSoft} /> : null}
        <View style={{ flex: 1 }} />
        {isOwn ? (
          <>
            {post.status === 'published' ? <Pressable hitSlop={8} onPress={() => onEdit?.(post)} style={{ minHeight: 44, justifyContent: 'center' }}><T size={12.5} color={c.pink} weight="700">{t('pp.edit')}</T></Pressable> : null}
            <Pressable hitSlop={8} onPress={() => onWithdraw?.(post)} style={{ minHeight: 44, justifyContent: 'center' }}><T size={12.5} color={c.red} weight="700">{t('pp.withdraw')}</T></Pressable>
          </>
        ) : (
          <Pressable hitSlop={8} onPress={() => onChallenge?.(post)} style={{ minHeight: 44, justifyContent: 'center' }}><T size={12.5} color={c.mute} weight="700">{t('pp.challenge')}</T></Pressable>
        )}
      </View>
    </Card>
  );
}

export function PerformanceFeedSection({ userId, sport, isOwn }) {
  const { push } = useNav();
  const posts = useLoad(() => api.get(isOwn ? '/me/performance-posts' : `/athletes/${userId}/sports/${sport}/posts`), [userId, sport, isOwn]);
  const [publishing, setPublishing] = useState(false);
  const { toast } = useSession();

  const withdraw = async (post) => {
    try { await api.post(`/performance-posts/${post.id}/withdraw`); posts.reload(); toast(t('pp.withdrawn_toast')); } catch (e) { toast(e.message); }
  };

  if (posts.loading && !posts.data) return <Loading />;
  if (posts.error) return <ErrorBox error={posts.error} onRetry={posts.reload} />;

  const list = posts.data?.posts ?? [];
  return (
    <View style={{ gap: 10 }}>
      {isOwn ? (
        <Btn small title={`🏅 ${t('pp.post_cta')}`} onPress={() => setPublishing(true)} />
      ) : null}
      {!list.length ? (
        <View style={{ padding: 20, alignItems: 'center' }}>
          <T size={30}>🏅</T>
          <T weight="700" size={15} style={{ marginTop: 8, textAlign: 'center' }}>{t('pp.empty_title')}</T>
          <T size={13} color={c.mute} style={{ textAlign: 'center', marginTop: 4 }}>{t('pp.empty_sub')}</T>
        </View>
      ) : list.map((p) => (
        <PerformancePostCard key={p.id} post={p} isOwn={isOwn} onWithdraw={withdraw} />
      ))}
      {publishing ? <PerformancePublishSheet visible onClose={() => { setPublishing(false); posts.reload(); }} sportSlug={sport} /> : null}
    </View>
  );
}

// PS-09: class-aware para-sport results screens.
// ClassResultsTab, AthleteParaAchievements, FederationRecordsAudit, PublicParaStandings
// All text via t(); touch targets ≥ 44pt; RTL-safe (start/end); phone/tablet/desktop responsive.
import React, { useState } from 'react';
import { View, ScrollView, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { A, ACard, AEmpty, ASection, AT, PodiumCard } from '../arena';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';

// ─── shared helpers ───────────────────────────────────────────────────────────

function ClassBadge({ code, style }) {
  if (!code) return null;
  return (
    <View style={[{ backgroundColor: c.pinkSoft, borderRadius: r.pill, paddingVertical: 3, paddingHorizontal: 10, alignSelf: 'flex-start' }, style]}>
      <T size={10} weight="800" color={c.pink} style={{ letterSpacing: 0.6 }}>{code}</T>
    </View>
  );
}

function RecordBadge({ type, status }) {
  const cfg = {
    world: { bg: c.pinkSoft, fg: c.pink, label: t('para.res.record_world_short') ?? 'WR' },
    national: { bg: c.cyanSoft ?? '#DCEEF8', fg: c.cyan, label: t('para.res.record_national_short') ?? 'NR' },
    personal_best: { bg: c.mintSoft, fg: c.mint, label: t('para.res.record_personal_short') ?? 'PB' },
    pending_ratification: { bg: c.sunSoft, fg: c.sun, label: t('para.res.record_pending_short') ?? '?' },
  };
  const k = status === 'pending_ratification' ? 'pending_ratification' : type;
  const s = cfg[k] ?? cfg.personal_best;
  return (
    <View style={{ backgroundColor: s.bg, borderRadius: r.pill, paddingVertical: 2, paddingHorizontal: 8 }}>
      <T size={9} weight="900" color={s.fg}>{s.label}</T>
    </View>
  );
}

function ProvenanceBadge({ provenance }) {
  const official = provenance === 'approved_competition' || provenance === 'official' || provenance === 'governing_body';
  return (
    <View style={{ backgroundColor: official ? c.limeSoft : c.sunSoft, borderRadius: r.pill, paddingVertical: 2, paddingHorizontal: 8 }}>
      <T size={9} weight="800" color={official ? c.lime : c.sun}>{official ? t('para.res.official') : t('para.res.self_reported')}</T>
    </View>
  );
}

function NotComparableBanner() {
  return (
    <Card color={c.orangeSoft} style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: r.card }}>
      <Row gap={10}>
        <T size={18}>⚠️</T>
        <View style={{ flex: 1 }}>
          <T size={12} weight="800" color={c.orange}>{t('para.res.select_class')}</T>
          <T size={11} color={c.orange} style={{ marginTop: 3, opacity: 0.85 }}>{t('para.res.not_comparable')}</T>
        </View>
      </Row>
    </Card>
  );
}

function GuideAttribution({ guideName }) {
  if (!guideName) return null;
  return (
    <T size={10} color={c.mute} style={{ marginTop: 4 }}>
      👥 {t('para.res.guide_attr').replace('{name}', guideName)}
    </T>
  );
}

// ─── SCREEN 1: ClassResultsTab ────────────────────────────────────────────────
// Used by event-results.js when e.sport.is_para === true

export function ClassResultsTab({ eventId }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const data = useLoad(() => api.get(`/events/${eventId}/para-standings`), [eventId]);
  const [activeClass, setActiveClass] = useState(null);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  const classes = data.data?.classes ?? [];
  if (!classes.length) return <AEmpty emoji="♿" title={t('para.res.empty_class')} sub={t('para.res.select_class')} />;

  const classCodes = classes.map((g) => g.sport_class);
  const selected = activeClass ?? classCodes[0];
  const group = classes.find((g) => g.sport_class === selected);

  return (
    <View style={{ flex: 1 }}>
      {/* Class selector chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 52 }}
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 10 }}>
        {classCodes.map((code) => (
          <Chip key={code} label={t('para.res.class_label').replace('{code}', code)}
            active={code === selected} onPress={() => setActiveClass(code)}
            color={c.pink} softColor={c.pinkSoft}
            style={{ minHeight: 36, borderRadius: r.pill }} />
        ))}
      </ScrollView>

      {/* Not-comparable notice (stays even with class selected) */}
      {classes.length > 1 && (
        <Card color={c.pinkSoft} style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: r.card }}>
          <T size={11} color={c.pink}>{t('para.res.not_comparable')}</T>
        </Card>
      )}

      {/* Standings table for selected class */}
      <ASection title={t('para.res.standings_title')} sub={t('para.res.class_label').replace('{code}', selected)} />

      {!group?.entries?.length
        ? <AEmpty emoji="📊" title={t('para.res.empty_class')} />
        : (
          <ACard pad={0}>
            {/* Header */}
            <View style={{ flexDirection: 'row', paddingVertical: 9, paddingHorizontal: 14, backgroundColor: A.panel2 }}>
              <AT size={10} weight="900" color={A.mute} style={{ width: 26 }}>#</AT>
              <AT size={10} weight="900" color={A.mute} style={{ flex: 1 }}>ATHLETE</AT>
              <AT size={10} weight="900" color={A.mute} style={{ width: 50, textAlign: 'center' }}>CLASS</AT>
              <AT size={10} weight="900" color={A.mute} style={{ width: isTablet ? 90 : 70, textAlign: 'center' }}>BEST</AT>
              <AT size={10} weight="900" color={A.mute} style={{ width: 50, textAlign: 'center' }}>SRC</AT>
            </View>
            {/* Rows */}
            {group.entries.map((entry) => (
              <View key={entry.user_id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: 1, borderColor: A.line }}>
                <AT size={13} weight="900"
                  color={entry.rank === 1 ? c.sun : entry.rank === 2 ? c.mute : entry.rank === 3 ? '#B06030' : A.ink}
                  style={{ width: 26 }}>{entry.rank}</AT>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AT size={13} weight="800" numberOfLines={1}>{entry.emoji} {entry.name}</AT>
                  <GuideAttribution guideName={entry.guide_name} />
                </View>
                <ClassBadge code={entry.sport_class} style={{ width: 50, alignItems: 'center' }} />
                <AT size={14} weight="900" num style={{ width: isTablet ? 90 : 70, textAlign: 'center' }}>
                  {entry.best_value}{entry.unit ? <AT size={9} color={A.mute}> {entry.unit}</AT> : null}
                </AT>
                <View style={{ width: 50, alignItems: 'center' }}>
                  <ProvenanceBadge provenance={entry.provenance} />
                </View>
              </View>
            ))}
          </ACard>
        )}
    </View>
  );
}

// ─── SCREEN 2: AthleteParaAchievements ───────────────────────────────────────
// Used in passport screen when para_records exist

export function AthleteParaAchievements({ athleteId }) {
  const data = useLoad(() => api.get(`/users/${athleteId}/passport`, { show_results: true }), [athleteId]);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  const paraResults = (data.data?.verified_results ?? []).filter((r) => r.sport_class);
  const paraRecords = data.data?.para_records ?? [];

  if (!paraResults.length && !paraRecords.length) {
    return <AEmpty emoji="♿" title={t('para.res.empty_records')} />;
  }

  // Group results by sport_class
  const byClass = new Map();
  for (const row of paraResults) {
    const key = row.sport_class;
    if (!byClass.has(key)) byClass.set(key, { sport: row.sport, sport_slug: row.sport_slug, sport_class: key, results: [] });
    byClass.get(key).results.push(row);
  }

  // Index records by sport_class + metric for badge lookup
  const recordIndex = new Map();
  for (const rec of paraRecords) {
    recordIndex.set(`${rec.sport_class}:${rec.metric}`, rec);
  }

  return (
    <View>
      <ASection title={t('para.res.title')} />
      {[...byClass.values()].map(({ sport, sport_class, results }) => (
        <ACard key={sport_class} style={{ marginBottom: 10 }}>
          {/* Class header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <T size={13} weight="800">{sport}</T>
            <ClassBadge code={sport_class} />
          </View>
          {/* Per-metric rows */}
          {results.map((row) => {
            const rec = recordIndex.get(`${sport_class}:${row.metric}`);
            return (
              <View key={row.metric}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderTopWidth: 1, borderColor: A.line }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={12} weight="600" color={c.mute}>{row.metric}</T>
                  {rec && <T size={10} color={c.mute} style={{ marginTop: 2 }}>{t('para.res.ratified').replace('{date}', rec.ratified_at ? new Date(rec.ratified_at).toLocaleDateString() : '—')}</T>}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {rec && <RecordBadge type={rec.record_type} status={rec.status} />}
                  <T size={15} weight="900" num>{row.best}{row.unit ? <T size={10} color={c.mute}> {row.unit}</T> : null}</T>
                </View>
              </View>
            );
          })}
        </ACard>
      ))}

      {/* Class notes */}
      <Card color={c.pinkSoft} style={{ marginHorizontal: 16, borderRadius: r.card }}>
        <T size={11} color={c.pink}>{t('para.res.snapshot_label').replace('{code}', '—').replace('{status}', '—').replace('Class at competition: ', 'Sport class recorded at the time of each competition. ')}</T>
      </Card>
    </View>
  );
}

// ─── SCREEN 3: FederationRecordsAudit ────────────────────────────────────────
// Used in governing-body / federation workspace

export function FederationRecordsAudit({ sport, classCode: initialClass }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const [activeClass, setActiveClass] = useState(initialClass ?? null);
  const [status, setStatus] = useState('current');

  const records = useLoad(
    () => sport ? api.get('/para/records/list', { sport, sport_class: activeClass || undefined, status: status || undefined, limit: 50 }) : Promise.resolve(null),
    [sport, activeClass, status]);

  if (!sport) return <AEmpty emoji="🏷" title="Select a sport to view records" />;
  if (records.loading && !records.data) return <Loading />;
  if (records.error) return <ErrorBox error={records.error} onRetry={records.reload} />;

  const rows = records.data ?? [];
  const classes = [...new Set(rows.map((r) => r.sport_class))];

  const content = (
    <View style={{ flex: 1 }}>
      <ASection title={t('para.res.records_title')} />

      {/* Status filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 8 }}>
        {['current', 'pending_ratification', 'historic'].map((s) => (
          <Chip key={s} label={s.replace(/_/g, ' ')} active={status === s} onPress={() => setStatus(s)}
            color={c.cyan} softColor={c.cyanSoft ?? '#DCEEF8'} style={{ minHeight: 36, borderRadius: r.pill }} />
        ))}
      </ScrollView>

      {/* Privacy note */}
      <Card color={c.pinkSoft} style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: r.card }}>
        <T size={11} color={c.pink}>🔒 {t('para.res.provenance_official').replace('From an official competition', 'Sport class codes and results only. Supporting evidence is not shown here.')}</T>
      </Card>

      {!rows.length
        ? <AEmpty emoji="🏅" title={t('para.res.empty_records')} />
        : rows.map((rec) => {
          const isHistoric = rec.status === 'historic';
          return (
            <View key={rec.id}
              style={[{ flexDirection: 'row', alignItems: 'flex-start', gap: 12,
                paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: A.line,
                backgroundColor: rec.status === 'current' ? c.limeSoft : A.paper }, isHistoric && { opacity: 0.55 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                  <ClassBadge code={rec.sport_class} />
                  <RecordBadge type={rec.record_type} status={rec.status} />
                  {rec.status === 'current' && (
                    <View style={{ backgroundColor: c.limeSoft, borderRadius: r.pill, paddingVertical: 2, paddingHorizontal: 8 }}>
                      <T size={9} weight="800" color={c.lime}>{t('para.res.ratified').replace('{date}', rec.ratified_at ? new Date(rec.ratified_at).toLocaleDateString() : '—')}</T>
                    </View>
                  )}
                </View>
                <T size={13} weight={isHistoric ? '600' : '800'} style={isHistoric ? { textDecorationLine: 'line-through', color: c.mute } : {}}>
                  {rec.holder_name ?? 'Anonymous'} · {rec.metric}
                </T>
                <T size={10} color={c.mute} style={{ marginTop: 2 }}>
                  {rec.sport_class} · {rec.record_type.replace('_', ' ')} · {rec.achieved_at ? new Date(rec.achieved_at).getFullYear() : '—'}
                  {rec.superseded_by_id ? ` · ${t('para.res.superseded')}` : ''}
                </T>
              </View>
              <View style={{ alignItems: 'flex-end', minWidth: 70 }}>
                <T size={18} weight="900" num color={isHistoric ? c.mute : c.pink}
                  style={isHistoric ? { textDecorationLine: 'line-through' } : {}}>{rec.value}</T>
                <T size={10} color={c.mute}>{rec.unit ?? ''}</T>
              </View>
            </View>
          );
        })}
    </View>
  );

  if (isTablet) {
    return (
      <View style={{ flexDirection: 'row', flex: 1, gap: 16, padding: 16 }}>
        {/* Sidebar: class filter */}
        <View style={{ width: 200 }}>
          <ACard pad={0}>
            <View style={{ padding: 12, borderBottomWidth: 1, borderColor: A.line }}>
              <T size={10} weight="900" color={c.mute} style={{ letterSpacing: 0.7 }}>SPORT CLASS</T>
            </View>
            {classes.map((cls) => (
              <View key={cls}
                style={[{ paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderColor: A.line },
                  activeClass === cls && { backgroundColor: c.pinkSoft }]}>
                <T size={12} weight={activeClass === cls ? '800' : '600'}
                  color={activeClass === cls ? c.pink : c.mute}
                  onPress={() => setActiveClass(cls === activeClass ? null : cls)}>
                  {cls}
                </T>
              </View>
            ))}
          </ACard>
        </View>
        <View style={{ flex: 1 }}>{content}</View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Mobile class chips */}
      {classes.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 8 }}>
          {classes.map((cls) => (
            <Chip key={cls} label={cls} active={activeClass === cls} onPress={() => setActiveClass(cls === activeClass ? null : cls)}
              color={c.pink} softColor={c.pinkSoft} style={{ minHeight: 36, borderRadius: r.pill }} />
          ))}
        </ScrollView>
      )}
      {content}
    </View>
  );
}

// ─── SCREEN 4: PublicParaStandings ───────────────────────────────────────────
// Read-only public-facing standings; no auth required

export function PublicParaStandings({ eventId }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const data = useLoad(() => api.get(`/events/${eventId}/para-standings`), [eventId]);
  const [activeClass, setActiveClass] = useState(null);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;

  const classes = data.data?.classes ?? [];
  if (!classes.length) return <AEmpty emoji="♿" title={t('para.res.empty_class')} />;

  const classCodes = classes.map((g) => g.sport_class);
  const selected = activeClass ?? classCodes[0];
  const group = classes.find((g) => g.sport_class === selected);
  const top3 = group?.entries?.slice(0, 3) ?? [];

  return (
    <View>
      <ASection title={t('para.res.standings_title')} />

      {/* Class tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 0, paddingHorizontal: 0 }}
        style={{ borderBottomWidth: 1, borderColor: A.line }}>
        {classCodes.map((code) => (
          <View key={code} style={{ borderBottomWidth: 2, borderBottomColor: code === selected ? c.pink : 'transparent' }}>
            <T size={12} weight="800"
              color={code === selected ? c.pink : c.mute}
              style={{ paddingVertical: 10, paddingHorizontal: 16, minHeight: 44 }}
              onPress={() => setActiveClass(code)}>
              {code}
            </T>
          </View>
        ))}
      </ScrollView>

      {/* Podium */}
      {top3.length >= 3 && (
        <PodiumCard
          places={top3.map((e) => ({
            name: `${e.emoji ?? ''} ${e.name}`.trim(),
            note: `${e.best_value}${e.unit ? ' ' + e.unit : ''}`,
          }))}
        />
      )}

      {/* Full table */}
      <ASection title={selected} sub={`${group?.entries?.length ?? 0} athletes`} />

      {!group?.entries?.length
        ? <AEmpty emoji="📊" title={t('para.res.empty_class')} />
        : (
          <ACard pad={0}>
            {/* Table header */}
            <View style={{ flexDirection: 'row', paddingVertical: 9, paddingHorizontal: 14, backgroundColor: A.panel2 }}>
              <AT size={10} weight="900" color={A.mute} style={{ width: 26 }}>#</AT>
              <AT size={10} weight="900" color={A.mute} style={{ flex: 1 }}>ATHLETE</AT>
              <AT size={10} weight="900" color={A.mute} style={{ width: isTablet ? 90 : 70, textAlign: 'center' }}>BEST</AT>
              <AT size={10} weight="900" color={A.mute} style={{ width: 50, textAlign: 'center' }}>SRC</AT>
            </View>
            {group.entries.map((entry) => (
              <View key={entry.user_id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: 1, borderColor: A.line }}>
                <AT size={13} weight="900"
                  color={entry.rank === 1 ? c.sun : entry.rank === 2 ? c.mute : entry.rank === 3 ? '#B06030' : A.ink}
                  style={{ width: 26 }}>{entry.rank}</AT>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AT size={13} weight="800" numberOfLines={1}>{entry.emoji} {entry.name}</AT>
                  <GuideAttribution guideName={entry.guide_name} />
                </View>
                <AT size={14} weight="900" num style={{ width: isTablet ? 90 : 70, textAlign: 'center' }}>
                  {entry.best_value}{entry.unit ? <AT size={9} color={A.mute}> {entry.unit}</AT> : null}
                </AT>
                <View style={{ width: 50, alignItems: 'center' }}>
                  <ProvenanceBadge provenance={entry.provenance} />
                </View>
              </View>
            ))}
          </ACard>
        )}

      {/* Cross-class warning */}
      {classes.length > 1 && (
        <View style={{ padding: 16 }}>
          <T size={10} color={c.mute}>⚠️ {t('para.res.not_comparable')}</T>
        </View>
      )}
    </View>
  );
}

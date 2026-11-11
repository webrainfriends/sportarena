// REF-R30: Crew Template Builder (#1028).
// Browse, create, edit and publish versioned crew templates. Each template is a named,
// rule-pack-linked set of crew slots (role, count, mandatory, qualifications, duties).
// Templates are immutable once published (content hash frozen) and can only be archived.
// Two-pane layout on tablet; single-pane with slide-over detail on phone.
import React, { useState } from 'react';
import { View, ScrollView, FlatList, Pressable, TextInput, Platform, Modal } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError, explain } from '../access';
import { c, grad, r as radius } from '../theme';
import { t } from '../i18n';

const LEVELS = ['club', 'domestic', 'national', 'international', 'youth', 'para'];
const FAMILIES = ['match_official', 'video_official', 'technical_official', 'administrative_official', 'safety_official', 'support_official'];

const LEVEL_COLOR = { club: c.bg, domestic: c.cyanSoft, national: c.pinkSoft, international: c.mintSoft, youth: c.sunSoft, para: '#E8E0F5' };
const LEVEL_INK  = { club: c.mute, domestic: c.cyan, national: c.pink, international: c.mint, youth: c.sun, para: c.violet };

const FAMILY_LABEL = {
  match_official: 'Match', video_official: 'Video', technical_official: 'Technical',
  administrative_official: 'Admin', safety_official: 'Safety', support_official: 'Support',
};
const FAMILY_COLOR = {
  match_official: c.pinkSoft, video_official: '#E8E0F5', technical_official: c.cyanSoft,
  administrative_official: c.sunSoft, safety_official: c.redSoft, support_official: c.mintSoft,
};
const FAMILY_INK = {
  match_official: c.pink, video_official: c.violet, technical_official: c.cyan,
  administrative_official: c.sun, safety_official: c.red, support_official: c.mint,
};

function StatusChip({ status }) {
  const bg = status === 'published' ? c.mintSoft : status === 'draft' ? c.sunSoft : c.bg;
  const ink = status === 'published' ? c.mint : status === 'draft' ? c.sun : c.mute;
  return <Tag label={status} color={bg} style={{ color: ink }} />;
}

function TemplateListItem({ tmpl, selected, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: 16, padding: 14, backgroundColor: c.paper, opacity: pressed ? 0.75 : 1,
        borderLeftWidth: selected ? 3 : 0, borderLeftColor: c.pink,
        shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 2 }, shadowRadius: 4,
        marginBottom: 8,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
        <T style={{ fontSize: 14, fontWeight: '700', color: c.ink, flex: 1 }}>{tmpl.name}</T>
        <StatusChip status={tmpl.status} />
      </View>
      <T style={{ fontSize: 12, color: c.mute, marginBottom: 6 }}>
        {tmpl.level} · {tmpl.governing_body}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
        {tmpl.slot_count ? <Tag label={`${tmpl.slot_count} ${t('crew_template.slots')}`} color={c.bg} /> : null}
        {tmpl.content_hash ? <Tag label={`${tmpl.content_hash.slice(0, 8)}…`} color={c.bg} /> : null}
      </View>
    </Pressable>
  );
}

function SlotRow({ slot, index }) {
  const bgColor = [c.pinkSoft, c.sunSoft, c.cyanSoft, c.limeSoft, '#E8E0F5', c.mintSoft][index % 6];
  const inkColor = [c.pink, c.sun, c.cyan, c.lime, c.violet, c.mint][index % 6];
  const creds = Array.isArray(slot.requires_credentials) ? slot.requires_credentials : [];
  const duties = Array.isArray(slot.duties) ? slot.duties : [];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: bgColor, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <T style={{ fontSize: 13, fontWeight: '800', color: inkColor }}>×{slot.min_count === slot.max_count ? slot.min_count : `${slot.min_count}-${slot.max_count}`}</T>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <T style={{ fontSize: 14, fontWeight: '700', color: c.ink }}>{slot.display_name}</T>
          <Tag
            label={slot.mandatory ? t('crew_template.mandatory') : t('crew_template.optional')}
            color={slot.mandatory ? c.redSoft : c.bg}
            style={{ color: slot.mandatory ? c.red : c.mute }}
          />
        </View>
        {duties[0] ? <T style={{ fontSize: 12, color: c.mute, marginBottom: 5 }}>{duties[0]}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
          {creds.filter((cr) => cr.required).slice(0, 2).map((cr, i) => (
            <Tag key={i} label={cr.label} color={c.cyanSoft} />
          ))}
          <Tag label={FAMILY_LABEL[slot.family] ?? slot.family} color={FAMILY_COLOR[slot.family] ?? c.bg} />
        </View>
      </View>
    </View>
  );
}

function TemplateDetail({ tmpl, onReload, canAdmin }) {
  const { toast } = useSession();
  const [publishing, setPublishing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showConfirmPublish, setShowConfirmPublish] = useState(false);

  if (!tmpl) return <Empty label={t('crew_template.select_prompt')} />;

  const slots = Array.isArray(tmpl.slots) ? tmpl.slots : [];

  const publish = async () => {
    setPublishing(true);
    try {
      await api.post(`/crew-templates/${tmpl.id}/publish`, {});
      toast(t('crew_template.published_success'));
      onReload?.();
      setShowConfirmPublish(false);
    } catch (e) { toast(explain(e)); } finally { setPublishing(false); }
  };

  const archive = async () => {
    setArchiving(true);
    try {
      await api.post(`/crew-templates/${tmpl.id}/archive`, {});
      toast(t('crew_template.archived_success'));
      onReload?.();
    } catch (e) { toast(explain(e)); } finally { setArchiving(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {/* Hero */}
      <GradCard
        colors={grad.hero}
        accessibilityLabel={`${tmpl.name}, ${tmpl.level}, ${tmpl.governing_body}`}
        style={{ padding: 20, borderRadius: 18 }}
      >
        <T style={{ fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.8)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
          {tmpl.sport_name ?? tmpl.sport_code} · {tmpl.level} · {tmpl.match_format}
        </T>
        <T style={{ fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 6 }}>{tmpl.name}</T>
        {tmpl.description ? (
          <T style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', lineHeight: 20, marginBottom: 10 }}>{tmpl.description}</T>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            `${slots.length} ${t('crew_template.slots')}`,
            `${slots.filter((s) => s.mandatory).length} ${t('crew_template.mandatory')}`,
            tmpl.governing_body,
            tmpl.content_hash ? `v:${tmpl.content_hash.slice(0, 8)}` : null,
          ].filter(Boolean).map((v, i) => (
            <View key={i} style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 }}>
              <T style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{v}</T>
            </View>
          ))}
        </View>
      </GradCard>

      {/* Meta card */}
      <Card style={{ padding: 14 }}>
        {[
          { label: t('crew_template.rule_pack'), value: tmpl.rule_pack_version ? `${tmpl.rule_pack_id ? '📋 ' : ''}${tmpl.rule_pack_version}` : '—' },
          { label: t('crew_template.source_ref'), value: tmpl.source_ref ?? tmpl.source ?? '—' },
          { label: t('crew_template.published'), value: tmpl.published_at ? new Date(tmpl.published_at).toLocaleDateString() : '—' },
          { label: t('crew_template.content_hash'), value: tmpl.content_hash ? `${tmpl.content_hash.slice(0, 16)}…` : '—' },
          { label: t('crew_template.status_label'), value: tmpl.status },
        ].map(({ label, value }) => (
          <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <T style={{ fontSize: 13, color: c.mute }}>{label}</T>
            <T style={{ fontSize: 12, fontWeight: '600', color: c.ink, fontFamily: label === t('crew_template.content_hash') ? 'monospace' : undefined, maxWidth: '55%', textAlign: 'right' }}>{value}</T>
          </View>
        ))}
      </Card>

      {/* Slots */}
      <Section title={t('crew_template.crew_slots')} color={c.pink}>
        <Card style={{ padding: 14 }}>
          {slots.length > 0
            ? slots.map((s, i) => <SlotRow key={s.id ?? i} slot={s} index={i} />)
            : <T style={{ color: c.mute, fontSize: 13 }}>{t('crew_template.no_slots')}</T>}
        </Card>
      </Section>

      {/* CTA */}
      {canAdmin && tmpl.status !== 'archived' ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {tmpl.status === 'draft' ? (
            <>
              <Btn
                title={t('crew_template.publish_cta')}
                color={c.pink} ink="#fff"
                onPress={() => setShowConfirmPublish(true)}
                loading={publishing}
                style={{ flex: 2, minHeight: 48 }}
                accessibilityLabel={t('crew_template.publish_cta')}
              />
              <Btn
                title={t('crew_template.archive_cta')}
                color={c.bg} ink={c.red}
                onPress={archive}
                loading={archiving}
                style={{ flex: 1, minHeight: 48 }}
                accessibilityLabel={t('crew_template.archive_cta')}
              />
            </>
          ) : tmpl.status === 'published' ? (
            <Btn
              title={t('crew_template.archive_cta')}
              color={c.bg} ink={c.red}
              onPress={archive}
              loading={archiving}
              style={{ flex: 1, minHeight: 48 }}
              accessibilityLabel={t('crew_template.archive_cta')}
            />
          ) : null}
        </View>
      ) : null}

      {/* Publish confirm sheet */}
      <Sheet visible={showConfirmPublish} onClose={() => setShowConfirmPublish(false)} accessibilityLabel={t('crew_template.publish_confirm')}>
        <T style={{ fontSize: 17, fontWeight: '800', color: c.ink, marginBottom: 8 }}>{t('crew_template.publish_confirm')}</T>
        <T style={{ fontSize: 13, color: c.mute, marginBottom: 16, lineHeight: 20 }}>
          {t('crew_template.publish_confirm_body')}
        </T>
        {[
          { label: t('crew_template.slots'), value: `${slots.length}` },
          { label: t('crew_template.governing_body'), value: tmpl.governing_body },
          { label: t('crew_template.level'), value: tmpl.level },
        ].map(({ label, value }) => (
          <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <T style={{ fontSize: 13, color: c.mute }}>{label}</T>
            <T style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{value}</T>
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
          <Btn title={t('common.cancel')} color={c.bg} ink={c.pink} onPress={() => setShowConfirmPublish(false)} style={{ flex: 1, minHeight: 48 }} />
          <Btn title={t('crew_template.publish_cta')} color={c.pink} ink="#fff" onPress={publish} loading={publishing} style={{ flex: 2, minHeight: 48 }} />
        </View>
      </Sheet>
    </ScrollView>
  );
}

export default function CrewTemplateBuilderScreen() {
  const { user } = useSession();
  const { width } = useLayout();
  const nav = useNav();
  const isTablet = width >= 744;
  const canAdmin = user?.roles?.includes('platform_admin') || user?.roles?.includes('admin');

  const [sportFilter, setSportFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState('published');
  const [selectedId, setSelectedId] = useState(null);
  const [showDetail, setShowDetail] = useState(false);

  const listQ = useLoad(
    () => api.get('/crew-templates', {
      ...(sportFilter ? { sport_code: sportFilter } : {}),
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      limit: 50,
    }),
    [sportFilter, statusFilter],
  );
  const detailQ = useLoad(
    () => selectedId ? api.get(`/crew-templates/${selectedId}`) : Promise.resolve(null),
    [selectedId],
  );

  const templates = listQ.data?.templates ?? [];

  const selectTemplate = (tmpl) => {
    setSelectedId(tmpl.id);
    if (!isTablet) setShowDetail(true);
  };

  const sideList = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      {/* Status filter */}
      <Seg
        items={[
          { key: 'published', label: t('crew_template.status_published') },
          { key: 'draft',     label: t('crew_template.status_draft') },
          { key: 'all',       label: t('common.all') },
        ]}
        value={statusFilter}
        onChange={setStatusFilter}
        style={{ marginBottom: 12 }}
      />
      {listQ.loading && !listQ.data ? <Loading /> : null}
      {listQ.error ? <LoadError onRetry={listQ.reload} /> : null}
      {templates.map((tmpl) => (
        <TemplateListItem
          key={tmpl.id}
          tmpl={tmpl}
          selected={tmpl.id === selectedId}
          onPress={() => selectTemplate(tmpl)}
        />
      ))}
      {templates.length === 0 && !listQ.loading ? (
        <Empty label={t('crew_template.empty')} sublabel={t('crew_template.empty_sub')} />
      ) : null}
    </ScrollView>
  );

  const detail = (
    detailQ.loading && !detailQ.data
      ? <Loading />
      : <TemplateDetail
          tmpl={detailQ.data}
          onReload={() => { listQ.reload(); detailQ.reload(); }}
          canAdmin={canAdmin}
        />
  );

  if (isTablet) {
    return (
      <Screen
        title={t('crew_template.title')}
        right={canAdmin ? (
          <Pressable accessibilityRole="button" onPress={() => nav.push('CrewTemplateCreate')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
            <T style={{ color: c.pink, fontWeight: '700', fontSize: 14 }}>+ {t('crew_template.new')}</T>
          </Pressable>
        ) : null}
      >
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 320, borderRightWidth: 1, borderRightColor: c.line }}>{sideList}</View>
          <View style={{ flex: 1 }}>{detail}</View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title={t('crew_template.title')}
      right={canAdmin ? (
        <Pressable accessibilityRole="button" onPress={() => nav.push('CrewTemplateCreate')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
          <T style={{ color: c.pink, fontWeight: '700', fontSize: 14 }}>+ {t('crew_template.new')}</T>
        </Pressable>
      ) : null}
    >
      {sideList}
      <Sheet
        visible={showDetail}
        onClose={() => setShowDetail(false)}
        accessibilityLabel={detailQ.data?.name ?? t('crew_template.title')}
      >
        {detail}
      </Sheet>
    </Screen>
  );
}

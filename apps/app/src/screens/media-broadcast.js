// Media rights (#482): the Broadcast tab of the event console, the single home for running an event's media and rights. Rights packages and licences, match-day
// production, streams, governed media, data feeds and reports. It sits beside Teams, People, Games and Business; nothing here duplicates them: games, people, sponsors and
// agreements are the event's own records, referenced.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStat, AT, ReasonSheet } from '../arena';
import { ErrorBox, Loading } from '../ui';
import { countryName } from '../country-picker';
import { rightChip, rightLabel, territoryText, money, fmtRange, fmtDT, nice, StateTag, Tags } from '../media-ui';
import { PackageForm, OfferForm, LicenceSheet } from './media-licence';
import { ProductionPanel, StreamsPanel } from './media-production';
import { AssetsPanel, RightsLog } from './media-assets';
import { ClipsPanel } from './clips';
import { t } from '../i18n';

const SUBS = [['rights', '🧾 Rights'], ['production', '🎬 Production'], ['streams', '📺 Streams'], ['media', '🎞️ Media'], ['highlights', `✨ ${t('clips.tab')}`], ['data', '📡 Data & reports'], ['accessibility', `♿ ${t('para.spec.a11y.media_a11y_tab')}`]];

export function BroadcastTab({ id, e, isOrg, games }) {
  const [sub, setSub] = useState('rights');
  if (!isOrg) return <AEmpty emoji="📡" title="Media and broadcast" sub="The organiser manages rights and production here. Media partners and crew open their own workspace from More." />;
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{SUBS.map(([k, l]) => <AChip key={k} label={l} active={sub === k} onPress={() => setSub(k)} />)}</View>
      {sub === 'rights' ? <RightsPanel id={id} e={e} games={games} /> : null}
      {sub === 'production' ? <ProductionPanel id={id} isOrg games={games} /> : null}
      {sub === 'streams' ? <StreamsPanel id={id} isOrg games={games} /> : null}
      {sub === 'media' ? <><AssetsPanel id={id} isOrg games={games} partners={[]} /><RightsLog id={id} /></> : null}
      {sub === 'highlights' ? <ClipsPanel id={id} games={games} /> : null}
      {sub === 'data' ? <DataPanel id={id} /> : null}
      {sub === 'accessibility' ? <AccessibilityPanel id={id} games={games} /> : null}
    </>
  );
}

function RightsPanel({ id, games }) {
  const pk = useLoad(() => api.get(`/events/${id}/media/packages`), [id]);
  const lic = useLoad(() => api.get(`/events/${id}/media/licences`, { limit: 100 }), [id]);
  const cols = useLoad(() => api.get(`/events/${id}/media/collections`), [id]);
  const [form, setForm] = useState(null);       // { pkg? } for the package form
  const [offer, setOffer] = useState(null);
  const [open, setOpen] = useState(null);
  const reload = () => { pk.reload(); lic.reload(); cols.reload(); };
  const err = pk.error ?? lic.error;
  if (err) return <ErrorBox error={err} onRetry={reload} />;
  if (!pk.data || !lic.data) return <Loading />;
  const live = lic.data.filter((l) => l.in_force), waiting = lic.data.filter((l) => ['proposed', 'negotiating'].includes(l.stage_now));
  const soon = live.filter((l) => l.days_left <= 30);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="🧾" value={pk.data.filter((p) => p.status !== 'withdrawn').length} label="Packages" /><AStat icon="✅" value={live.length} label="In force" /><AStat icon="⏳" value={waiting.length} label="Awaiting answer" /><AStat icon="📅" value={soon.length} label="Ending soon" />
      </View>

      <ASection title="Rights packages" sub="What you can license, and on what terms" action="+ New package" onAction={() => setForm({})} />
      {!pk.data.length ? <AEmpty emoji="🧾" title="No rights packages yet" sub="Define what you can offer: live video, replay, highlights, clips, audio, photography, press, data feed, archive or social, by territory and platform." action="Create the first package" onAction={() => setForm({})} /> : pk.data.map((p) => (
        <ACard key={p.id} pad={14} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><AT size={16} weight="900">{p.name}</AT><AT size={12.5} color={A.mute}>{p.scope_kind === 'event' ? 'Whole competition' : p.scope_kind === 'fixture' ? `One game${p.fixture_at ? ` · ${fmtDT(p.fixture_at)}` : ''}` : `Collection: ${p.collection_name}`} · {fmtRange(p.valid_from, p.valid_to)}</AT></View>
            <StateTag state={p.status} />
          </View>
          <Tags items={p.rights.map(rightLabel)} />
          <AT size={12.5} color={A.mute}>{territoryText(p, countryName)} · {p.platforms.length ? p.platforms.map(nice).join(', ') : 'every platform'} · {p.exclusivity === 'exclusive' ? 'Exclusive' : 'Non-exclusive'}{p.embargo_minutes ? ` · ${p.embargo_minutes} min delay after games` : ''}{p.sublicensing !== 'none' ? ` · sublicensing ${nice(p.sublicensing)}` : ''}</AT>
          <AT size={12.5} color={A.mute}>{p.active_licences} licensed · {p.open_proposals} open proposal{p.open_proposals === 1 ? '' : 's'}</AT>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {['draft', 'open', 'closed'].includes(p.status) ? <ABtn small title="Offer to a partner" tone="neon" onPress={() => setOffer(p)} /> : null}
            {p.status === 'draft' ? <ABtn small title="Open to partners" tone="lime" onPress={async () => { await api.post(`/media/packages/${p.id}/status`, { status: 'open' }).catch(() => null); reload(); }} /> : null}
            {p.status === 'open' ? <ABtn small title="Close" tone="ghost" onPress={async () => { await api.post(`/media/packages/${p.id}/status`, { status: 'closed' }).catch(() => null); reload(); }} /> : null}
            {!p.active_licences && !p.open_proposals && p.status !== 'withdrawn' ? <ABtn small title="Edit" tone="ghost" onPress={() => setForm({ pkg: p })} /> : null}
          </View>
        </ACard>
      ))}

      <ASection title="Licences" sub="Who holds which rights" />
      {!lic.data.length ? <AEmpty emoji="🤝" title="No licences yet" sub="Offer a package to a media partner, or open it so partners can apply." /> : lic.data.map((l) => (
        <ARow key={l.id} onPress={() => setOpen(l.id)} left={<AT size={22}>{l.in_force ? '📡' : '🤝'}</AT>} title={l.partner_name} sub={`${l.package_name} · ${l.approved_rights.map(rightLabel).join(', ')} · ${fmtRange(l.effective_from, l.effective_to)}${Number(l.fee_minor) ? ` · ${money(l.fee_minor, l.currency)}` : ''}`}
          right={<><StateTag state={l.stage_now} />{l.in_force && l.days_left <= 30 ? <StateTag state="attention" label={`${l.days_left}d left`} /> : null}</>} />
      ))}

      <PackageForm visible={!!form} onClose={() => setForm(null)} eventId={id} games={games} collections={cols.data ?? []} initial={form?.pkg} onSaved={reload} />
      {offer ? <OfferForm visible onClose={() => setOffer(null)} pkg={offer} onDone={reload} /> : null}
      {open ? <LicenceSheet id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </>
  );
}

const REPORTS = [['revenue', '💰 Rights revenue'], ['rights_inventory', '🧾 Inventory'], ['expiring', '⏳ Expiring'], ['partner_coverage', '🤝 Partner coverage'], ['production_readiness', '🎬 Readiness'], ['published_assets', '🎞️ Published media'], ['embargo_takedown', '🚫 Embargo & takedown']];

function DataPanel({ id }) {
  const { toast } = useSession();
  const [rep, setRep] = useState('revenue');
  const feeds = useLoad(() => api.get(`/events/${id}/media/feeds`), [id]);
  const r = useLoad(() => api.get(`/events/${id}/media/reports/${rep}`), [id, rep]);
  const [end, setEnd] = useState(null);
  return (
    <>
      <ASection title="Data feeds" sub="Licensed access to official scores and results" />
      {feeds.error ? <ErrorBox error={feeds.error} onRetry={feeds.reload} /> : !feeds.data ? <Loading /> : !feeds.data.length ? <AEmpty emoji="📡" title="No data feeds" sub="Grant one from a licence that carries the data-feed right." /> : feeds.data.map((f) => (
        <ACard key={f.id} pad={12} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><AT size={15} weight="800" style={{ flex: 1 }}>{f.consumer_name} · {f.partner_name}</AT><StateTag state={f.usable ? 'usable' : f.status === 'revoked' ? 'revoked' : 'expired'} label={f.usable ? 'Active' : f.status === 'revoked' ? 'Ended' : 'Expired'} /></View>
          <AT size={12.5} color={A.mute}>{f.datasets.map(nice).join(' · ')} · {f.mode === 'live' ? 'real-time' : `delayed ${f.delay_seconds}s`} · {f.rate_per_minute}/min · {f.daily_quota}/day</AT>
          <AT size={12.5} color={A.mute}>{f.credential_issued ? `${f.calls_today} calls today · ${f.calls_30d} in 30 days${f.last_call_at ? ` · last ${fmtDT(f.last_call_at)}` : ''}` : 'Credential not issued yet'} · until {fmtRange(f.valid_to)}</AT>
          {f.usable ? <ABtn small title="End now" tone="ghost" onPress={() => setEnd(f)} style={{ alignSelf: 'flex-start' }} /> : null}
        </ACard>
      ))}
      <ASection title="Reports" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{REPORTS.map(([k, l]) => <AChip key={k} label={l} active={rep === k} onPress={() => setRep(k)} />)}</View>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : <Report name={rep} data={r.data.data} />}
      <ReasonSheet visible={!!end} onClose={() => setEnd(null)} title="End this data feed" sub="Its credential stops working on the very next request, on every surface." presets={['Breach of terms', 'No longer needed', 'Credential exposed']} confirmLabel="End feed"
        onConfirm={async (reason) => { try { await api.post(`/media/feeds/${end.id}/revoke`, { reason }); feeds.reload(); toast('Feed ended'); } catch (x) { toast(x.message); } }} />
    </>
  );
}

function Bar({ label, n, max, sub }) {
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={`${label}: ${n}${sub ? `, ${sub}` : ''}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><AT size={13} weight="700" style={{ flex: 1 }}>{label}</AT><AT size={13} weight="900" num>{n}</AT></View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: A.line }}><View style={{ height: 6, borderRadius: 3, backgroundColor: A.violet, width: `${max ? Math.max(4, Math.round((n / max) * 100)) : 0}%` }} /></View>
      {sub ? <AT size={11.5} color={A.mute}>{sub}</AT> : null}
    </View>
  );
}

function Report({ name, data }) {
  if (name === 'revenue') {
    return (
      <>
        {!data.currencies.length ? <AEmpty emoji="💰" title="No fees contracted yet" /> : data.currencies.map((c) => (
          <ACard key={c.currency} pad={14} style={{ gap: 8 }}>
            <AT size={12} weight="800" color={A.mute}>{c.currency} · {c.licences} licence{c.licences === 1 ? '' : 's'}</AT>
            <AT size={26} weight="900" num>{money(c.contracted_minor, c.currency)}</AT><AT size={12.5} color={A.mute}>contracted{c.pending_minor ? ` · ${money(c.pending_minor, c.currency)} still being negotiated` : ''}</AT>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
              {[['Invoiced', c.invoiced_minor], ['Collected', c.collected_minor], ['Outstanding', c.outstanding_minor], ['Overdue', c.overdue_minor], ['Not yet invoiced', c.not_yet_invoiced_minor], ['Refunded', c.refunded_minor]].map(([k, v]) => (
                <View key={k}><AT size={10.5} weight="800" color={A.mute}>{k.toUpperCase()}</AT><AT size={16} weight="900" num color={k === 'Overdue' && v ? A.red : A.ink}>{money(v, c.currency)}</AT></View>
              ))}
            </View>
            {c.collected_minor ? <AT size={12} color={A.mute}>Collected: {money(c.collected_online_minor, c.currency)} online · {money(c.collected_offline_minor, c.currency)} recorded as received outside the platform</AT> : null}
          </ACard>
        ))}
        <ACard pad={12} tone={A.sun}><AT size={12.5} color={A.mute}>{data.note}</AT></ACard>
      </>
    );
  }
  if (name === 'rights_inventory') {
    const max = Math.max(1, ...data.rights.map((x) => x.packages));
    return <ACard pad={14} style={{ gap: 12 }}>{!data.rights.length ? <AT size={13} color={A.mute}>No packages.</AT> : data.rights.map((x) => <Bar key={x.right} label={rightChip(x.right)} n={x.packages} max={max} sub={`${x.licensed} licensed · ${x.unlicensed} open and unsold`} />)}</ACard>;
  }
  if (name === 'expiring') {
    return (
      <>
        {!data.licences.length && !data.feeds.length ? <AEmpty emoji="✅" title={`Nothing ends in the next ${data.days} days`} /> : null}
        {data.licences.map((l) => <ARow key={l.id} title={`${l.partner_name} · ${l.licence_no}`} sub={`Ends ${fmtRange(l.effective_to)}`} right={<StateTag state="attention" label={`${l.days_left} days`} />} />)}
        {data.feeds.map((f) => <ARow key={f.id} title={`${f.consumer_name} feed · ${f.partner_name}`} sub={`Ends ${fmtRange(f.valid_to)}`} />)}
      </>
    );
  }
  if (name === 'partner_coverage') {
    return !data.length ? <AEmpty emoji="🤝" title="No partners yet" /> : data.map((p) => <ARow key={p.partner_id} title={p.name} sub={`${nice(p.kind)} · ${p.rights.map(rightLabel).join(', ') || 'no rights in force'} · ${p.games_covered} game${p.games_covered === 1 ? '' : 's'} covered · ${p.crew} crew · ${p.streams} stream${p.streams === 1 ? '' : 's'} · ${p.assets_published} published`} right={<StateTag state={p.licences_in_force ? 'active' : 'expired'} label={`${p.licences_in_force}/${p.licences_total} in force`} />} />);
  }
  if (name === 'production_readiness') {
    return !data.length ? <AEmpty emoji="🎬" title="No upcoming games" /> : data.map((g) => <ARow key={g.id} title={`${g.home_name ?? 'TBC'} v ${g.away_name ?? 'TBC'}`} sub={`${fmtDT(g.scheduled_at)} · ${g.confirmed}/${g.crew} confirmed · ${g.badged}/${g.crew} badged · ${g.run_items} run-sheet · ${g.streams} stream${g.streams === 1 ? '' : 's'}${g.open_incidents ? ` · ${g.open_incidents} open issue${g.open_incidents === 1 ? '' : 's'}` : ''}`} right={<StateTag state={g.readiness} />} />);
  }
  if (name === 'published_assets') {
    return !data.groups.length ? <AEmpty emoji="🎞️" title="Nothing published yet" /> : <ACard pad={14} style={{ gap: 12 }}>{data.groups.map((g) => <Bar key={`${g.right}${g.state}`} label={`${rightLabel(g.right)} · ${nice(g.state)}`} n={g.count} max={data.groups[0].count} />)}</ACard>;
  }
  return !data.length ? <AEmpty emoji="✅" title="Nothing held back" sub="No asset is embargoed, expired, withdrawn, taken down or blocked." /> : data.map((a) => <ARow key={a.id} title={a.title} sub={`${rightLabel(a.right_kind)}${a.embargo_until ? ` · embargo to ${fmtDT(a.embargo_until)}` : ''}${a.expires_at ? ` · expires ${fmtDT(a.expires_at)}` : ''}${a.status_reason ? ` · ${a.status_reason}` : ''}`} right={<StateTag state={a.state} />} />);
}

const A11Y_STATUS_LABELS = { unknown: '❓', partial: '🟡', verified: '✅', not_available: '⛔' };
const A11Y_STATUS_OPTS = ['unknown', 'partial', 'verified', 'not_available'];

function A11yStatusPicker({ value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {A11Y_STATUS_OPTS.map((s) => (
        <AChip key={s} label={`${A11Y_STATUS_LABELS[s]} ${t(`para.spec.a11y.status_${s}`)}`} active={value === s} onPress={() => onChange(s)} />
      ))}
    </View>
  );
}

function AccessibilityPanel({ id, games }) {
  const { toast } = useSession();
  const [selGame, setSelGame] = useState(null);
  const fixtureId = selGame ?? (games?.[0]?.id ?? null);

  const settings = useLoad(() => fixtureId ? api.get(`/public/fixtures/${fixtureId}/accessibility-settings`) : Promise.resolve(null), [fixtureId]);
  const assets   = useLoad(() => api.get(`/events/${id}/accessible-media`, { limit: 50 }), [id]);
  const streams  = useLoad(() => api.get(`/events/${id}/accessible-streams`), [id]);

  const [captionUrl,  setCaptionUrl]  = useState('');
  const [audioUrl,    setAudioUrl]    = useState('');
  const [pbpEnabled,  setPbpEnabled]  = useState(true);
  const [capStatus,   setCapStatus]   = useState('unknown');
  const [audioStatus, setAudioStatus] = useState('unknown');
  const [txStatus,    setTxStatus]    = useState('unknown');
  const [saving,      setSaving]      = useState(false);

  React.useEffect(() => {
    if (!settings.data) return;
    const s = settings.data;
    setCaptionUrl(s.caption_provider_url ?? '');
    setAudioUrl(s.audio_desc_provider_url ?? '');
    setPbpEnabled(s.play_by_play_enabled ?? true);
    setCapStatus(s.caption_status ?? 'unknown');
    setAudioStatus(s.audio_desc_status ?? 'unknown');
    setTxStatus(s.transcript_status ?? 'unknown');
  }, [settings.data]);

  const saveSettings = async () => {
    if (!fixtureId) return;
    setSaving(true);
    try {
      await api.post(`/fixtures/${fixtureId}/accessibility-settings`, {
        caption_provider_url:    captionUrl || null,
        audio_desc_provider_url: audioUrl   || null,
        play_by_play_enabled:    pbpEnabled,
        caption_status:          capStatus,
        audio_desc_status:       audioStatus,
        transcript_status:       txStatus,
      });
      settings.reload();
      toast(t('para.spec.a11y.settings_saved'));
    } catch (x) {
      toast(x.message);
    } finally {
      setSaving(false);
    }
  };

  const saveAssetA11y = async (assetId, patch) => {
    try {
      await api.patch(`/media/assets/${assetId}/accessibility`, patch);
      assets.reload();
      toast(t('para.spec.a11y.asset_saved'));
    } catch (x) { toast(x.message); }
  };

  const saveStreamA11y = async (streamId, patch) => {
    try {
      await api.patch(`/media/streams/${streamId}/accessibility`, patch);
      streams.reload();
      toast(t('para.spec.a11y.stream_saved'));
    } catch (x) { toast(x.message); }
  };

  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AStat icon="♿" value={assets.data?.assets?.filter((a) => a.a11y_status === 'verified').length ?? 0} label={t('para.spec.a11y.stat_assets_verified')} />
        <AStat icon="📺" value={streams.data?.streams?.filter((s) => s.a11y_status === 'verified').length ?? 0} label={t('para.spec.a11y.stat_streams_verified')} />
        <AStat icon="📢" value={settings.data?.play_by_play_enabled ? 1 : 0} label={t('para.spec.a11y.stat_pbp')} />
      </View>

      {games && games.length > 1 ? (
        <>
          <ASection title={t('para.spec.a11y.select_fixture')} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {games.slice(0, 20).map((g) => (
              <AChip key={g.id} label={g.label ?? fmtDT(g.scheduled_at)} active={fixtureId === g.id} onPress={() => setSelGame(g.id)} />
            ))}
          </View>
        </>
      ) : null}

      <ASection title={t('para.spec.a11y.fixture_settings_title')} sub={t('para.spec.a11y.fixture_settings_sub')} />
      {settings.error ? <ErrorBox error={settings.error} onRetry={settings.reload} /> : !fixtureId ? <AEmpty emoji="♿" title={t('para.spec.a11y.no_fixture')} /> : (
        <ACard pad={14} style={{ gap: 12 }}>
          <AT size={12} weight="900" color={A.mute}>{t('para.spec.a11y.caption_provider_url')}</AT>
          <AT size={13}>{captionUrl || t('para.spec.a11y.not_set')}</AT>
          <AT size={12} weight="900" color={A.mute}>{t('para.spec.a11y.caption_status_label')}</AT>
          <A11yStatusPicker value={capStatus} onChange={setCapStatus} />
          <AT size={12} weight="900" color={A.mute}>{t('para.spec.a11y.audio_desc_provider_url')}</AT>
          <AT size={13}>{audioUrl || t('para.spec.a11y.not_set')}</AT>
          <AT size={12} weight="900" color={A.mute}>{t('para.spec.a11y.audio_desc_status_label')}</AT>
          <A11yStatusPicker value={audioStatus} onChange={setAudioStatus} />
          <AT size={12} weight="900" color={A.mute}>{t('para.spec.a11y.transcript_status_label')}</AT>
          <A11yStatusPicker value={txStatus} onChange={setTxStatus} />
          <AChip label={pbpEnabled ? t('para.spec.a11y.pbp_on') : t('para.spec.a11y.pbp_off')} active={pbpEnabled} onPress={() => setPbpEnabled((v) => !v)} />
          <ABtn title={saving ? t('para.spec.a11y.saving') : t('para.spec.a11y.save_settings')} tone="neon" onPress={saveSettings} style={{ alignSelf: 'flex-start' }} />
        </ACard>
      )}

      <ASection title={t('para.spec.a11y.media_assets_title')} sub={t('para.spec.a11y.media_assets_sub')} />
      {assets.error ? <ErrorBox error={assets.error} onRetry={assets.reload} /> : !assets.data ? <Loading /> : !assets.data.assets.length
        ? <AEmpty emoji="🎞️" title={t('para.spec.a11y.no_assets')} />
        : assets.data.assets.map((a) => (
          <ACard key={a.id} pad={12} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <AT size={14} weight="800" style={{ flex: 1 }}>{a.title ?? a.kind}</AT>
              <StateTag state={a.a11y_status} label={`${A11Y_STATUS_LABELS[a.a11y_status] ?? '❓'} ${t(`para.spec.a11y.status_${a.a11y_status}`)}`} />
            </View>
            {a.caption_ref ? <AT size={12} color={A.mute}>♿ {t('para.spec.a11y.caption_ref')}: {a.caption_ref}</AT> : null}
            {a.audio_desc_ref ? <AT size={12} color={A.mute}>🔊 {t('para.spec.a11y.audio_desc_ref')}: {a.audio_desc_ref}</AT> : null}
            {a.transcript_ref ? <AT size={12} color={A.mute}>📄 {t('para.spec.a11y.transcript_ref')}: {a.transcript_ref}</AT> : null}
            {a.alt_text ? <AT size={12} color={A.mute}>🖼️ {t('para.spec.a11y.alt_text')}: {a.alt_text}</AT> : null}
            <ABtn small title={t('para.spec.a11y.set_a11y')} tone="ghost" onPress={() =>
              saveAssetA11y(a.id, { a11y_status: a.a11y_status === 'verified' ? 'partial' : 'verified' })} />
          </ACard>
        ))}

      <ASection title={t('para.spec.a11y.streams_title')} sub={t('para.spec.a11y.streams_sub')} />
      {streams.error ? <ErrorBox error={streams.error} onRetry={streams.reload} /> : !streams.data ? <Loading /> : !streams.data.streams.length
        ? <AEmpty emoji="📺" title={t('para.spec.a11y.no_streams')} />
        : streams.data.streams.map((s) => (
          <ACard key={s.id} pad={12} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <AT size={14} weight="800" style={{ flex: 1 }}>{s.provider ?? t('para.spec.a11y.stream_label')}</AT>
              <StateTag state={s.a11y_status} label={`${A11Y_STATUS_LABELS[s.a11y_status] ?? '❓'} ${t(`para.spec.a11y.status_${s.a11y_status}`)}`} />
            </View>
            {s.caption_ref ? <AT size={12} color={A.mute}>♿ {t('para.spec.a11y.caption_ref')}: {s.caption_ref}</AT> : null}
            {s.audio_desc_ref ? <AT size={12} color={A.mute}>🔊 {t('para.spec.a11y.audio_desc_ref')}: {s.audio_desc_ref}</AT> : null}
            <ABtn small title={t('para.spec.a11y.set_a11y')} tone="ghost" onPress={() =>
              saveStreamA11y(s.id, { a11y_status: s.a11y_status === 'verified' ? 'partial' : 'verified' })} />
          </ACard>
        ))}
    </>
  );
}

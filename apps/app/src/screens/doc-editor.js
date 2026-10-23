// Visual page editor for document templates (issue #249). A scaled page shows the template the way it prints: tap a section to select it,
// drag its grip to reorder, edit in the panel (bottom on phones, right on wide screens). Amounts, numbers and names always come from the
// invoice itself, so data sections show grey structure bars, never invented figures.
import React, { useEffect, useRef, useState } from 'react';
import { Image, Modal, PanResponder, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API, api, authHeader } from '../api';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { Btn, Chip, Field, Seg, T } from '../ui';
import { Counter } from '../pickers';
import { c } from '../theme';

export const REQUIRED = { invoice: ['title', 'parties', 'lines', 'totals'] };
const LABEL = { header: 'Header', title: 'Title and number', parties: 'Seller and buyer', lines: 'Line items', totals: 'Totals', text: 'Your text', footer: 'Footer' };
const PAPER = { A4: [210, 297], Letter: [215.9, 279.4] };
const hex = (v, d) => (/^#[0-9A-Fa-f]{6}$/.test(v ?? '') ? v : d);
const GREY = '#E3E5EA';
const SELECT = '#B4182D';
const clone = (x) => JSON.parse(JSON.stringify(x));
const paperMM = (l) => (l.orientation === 'landscape' ? [...PAPER[l.paper]].reverse() : PAPER[l.paper]);

/** The brand kit's logo as an Image source (web: the protected file is fetched with the sign-in and shown from a blob URL). */
export function useLogo(kit, localUri) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url; let dead = false;
    setSrc(null);
    if (localUri) { setSrc({ uri: localUri }); return undefined; }
    if (!kit?.logo_asset_id) return undefined;
    if (Platform.OS === 'web') api.download(`/brand-kits/${kit.id}/logo`).then((b) => { if (!dead) { url = URL.createObjectURL(b); setSrc({ uri: url }); } }).catch(() => {});
    else setSrc({ uri: `${API}/brand-kits/${kit.id}/logo?v=${kit.logo_asset_id}`, headers: authHeader() });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [kit?.id, kit?.logo_asset_id, localUri]);
  return src;
}

const Bar = ({ w = '100%', h = 5, color = GREY, style }) => <View style={[{ width: w, height: h, borderRadius: 2, backgroundColor: color }, style]} />;

export function BlockPreview({ b, kit, logo, pt, accent, ink, layout }) {
  const g = Math.max(3, pt * 4);
  if (b.type === 'header') {
    return (
      <View>
        {layout.style === 'modern' ? <View style={{ height: Math.max(3, pt * 3), backgroundColor: accent, marginBottom: g }} /> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: g }}>
          {logo ? <Image source={logo} resizeMode="contain" style={{ width: pt * 60, height: pt * 26 }} /> : null}
          <View style={{ flex: 1, gap: g / 2 }}>
            {kit ? <T size={Math.max(6, pt * 14)} weight="800" color={accent} numberOfLines={1}>{kit.display_name}</T> : <Bar w="55%" h={Math.max(5, pt * 10)} />}
            {kit?.address || kit?.contact_email ? <T size={Math.max(4, pt * 8)} color={ink} numberOfLines={2}>{[kit.address, kit.contact_email].filter(Boolean).join(' · ')}</T> : <Bar w="35%" h={Math.max(3, pt * 5)} />}
          </View>
          <View style={{ alignItems: 'flex-end', gap: g / 2 }}><T size={Math.max(5, pt * 11)} weight="800" color={ink}>INVOICE</T><Bar w={pt * 36} h={Math.max(3, pt * 6)} /></View>
        </View>
        <View style={{ height: 1, backgroundColor: accent, marginTop: g }} />
      </View>
    );
  }
  if (b.type === 'title') return <View style={{ gap: g / 2 }}><T size={Math.max(7, pt * 16)} weight="800" color={accent}>INVOICE</T><Bar w="45%" h={Math.max(3, pt * 6)} /></View>;
  if (b.type === 'parties') {
    const col = (t) => <View style={{ flex: 1, gap: g / 2 }}><T size={Math.max(4, pt * 8)} weight="800" color={accent}>{t}</T><Bar w="70%" /><Bar w="55%" /><Bar w="40%" /></View>;
    return <View style={{ flexDirection: 'row', gap: g * 2 }}>{col('FROM')}{col('BILL TO')}</View>;
  }
  if (b.type === 'lines') {
    const hd = (t, f) => <T size={Math.max(4, pt * 8)} weight="800" color="#fff" style={{ flex: f }} numberOfLines={1}>{t}</T>;
    const row = (k) => <View key={k} style={{ flexDirection: 'row', gap: g, paddingVertical: g / 2, borderBottomWidth: 0.5, borderColor: GREY }}><Bar w="45%" /><View style={{ flex: 1 }} /><Bar w={pt * 14} /><Bar w={pt * 16} /></View>;
    return <View><View style={{ flexDirection: 'row', gap: g, backgroundColor: accent, padding: g / 2 }}>{hd('Description', 3)}{hd('Date', 1)}{hd('Tax', 1)}{hd('Amount', 1)}</View>{row(1)}{row(2)}</View>;
  }
  if (b.type === 'totals') {
    return <View style={{ alignItems: 'flex-end', gap: g / 2 }}><Bar w="42%" /><Bar w="42%" /><View style={{ width: '42%', height: 1, backgroundColor: accent }} /><Bar w="42%" h={Math.max(5, pt * 9)} color="#C9CCD3" /></View>;
  }
  if (b.type === 'text') {
    const size = { small: 8, normal: 9, large: 12 }[b.size] ?? 9;
    return <T size={Math.max(4, pt * size)} color={ink} style={{ textAlign: b.align ?? 'left' }}>{b.text || 'Type your text…'}</T>;
  }
  return null;
}

/** The scaled page. `onSelect(i)` / `onReorder(from, toFlowIndex)` are optional: without them it is a read-only thumbnail. */
export function PageCanvas({ layout, kit, logo, width, selected, onSelect, onReorder, onDragging }) {
  const [wmm] = paperMM(layout);
  const [, hmm] = paperMM(layout);
  const px = width / wmm;
  const pt = px * (25.4 / 72);
  const pad = px * layout.margin_mm;
  const accent = hex(kit?.primary_color, '#B4182D'), ink = hex(kit?.secondary_color, '#444441');
  const flow = layout.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.type !== 'footer');
  const footer = layout.blocks.map((b, i) => ({ b, i })).find((x) => x.b.type === 'footer');
  const heights = useRef({});
  const [drag, setDragState] = useState(null); // { i, dy, to }
  const dragRef = useRef(null);
  const setDrag = (d) => { dragRef.current = d; setDragState(d); };
  const live = useRef({});
  live.current = { flow, onReorder, onDragging, selected };

  const targetFor = (from, dy) => {
    const { flow: f } = live.current;
    let top = 0; const mids = f.map(({ i }) => { const h = heights.current[i] ?? 0; const m = top + h / 2; top += h; return m; });
    const at = f.findIndex((x) => x.i === from);
    const centre = mids[at] + dy;
    let to = 0; f.forEach((x, k) => { if (x.i !== from && mids[k] < centre) to += 1; });
    return to;
  };
  const grip = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { const i = live.current.selected; live.current.onDragging?.(true); setDrag({ i, dy: 0, to: live.current.flow.findIndex((x) => x.i === i) }); },
    onPanResponderMove: (_, g) => { const d = dragRef.current; if (d) setDrag({ ...d, dy: g.dy, to: targetFor(d.i, g.dy) }); },
    onPanResponderRelease: (_, g) => { const d = dragRef.current; setDrag(null); live.current.onDragging?.(false); if (d) live.current.onReorder?.(d.i, targetFor(d.i, g.dy)); },
    onPanResponderTerminate: () => { live.current.onDragging?.(false); setDrag(null); },
  })).current;

  const frame = (i, children, extra) => (
    <Pressable key={i} disabled={!onSelect} onPress={() => onSelect(i)} onLayout={(e) => { heights.current[i] = e.nativeEvent.layout.height; }}
      style={[{ borderWidth: 1.5, borderColor: selected === i ? SELECT : 'transparent', borderRadius: 3, padding: 3, marginVertical: 1 }, drag?.i === i && { transform: [{ translateY: drag.dy }], zIndex: 20, opacity: 0.85, backgroundColor: '#fff' }, extra]}>
      {children}
      {selected === i && onReorder ? (
        <View {...grip.panHandlers} accessibilityLabel="Drag to move this section" style={{ position: 'absolute', top: -13, right: 6, backgroundColor: SELECT, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 2, cursor: 'grab' }}>
          <T size={11} color="#fff" weight="700">⠿ Move</T>
        </View>
      ) : null}
    </Pressable>
  );
  const dropAt = drag ? flow.filter((x) => x.i !== drag.i)[drag.to]?.i ?? 'end' : null;

  return (
    <View style={{ width, minHeight: width * (hmm / wmm), backgroundColor: '#fff', borderRadius: 3, overflow: Platform.OS === 'web' ? 'visible' : 'hidden', boxShadow: Platform.OS === 'web' ? '0 6px 24px rgba(15,23,42,0.18)' : undefined, elevation: 4, shadowColor: '#0F172A', shadowOpacity: 0.18, shadowRadius: 10 }}>
      <View style={{ padding: pad, paddingBottom: pad + Math.max(14, pt * 22), gap: Math.max(4, pt * 8), flex: 1 }}>
        {flow.map(({ b, i }) => (
          <React.Fragment key={i}>
            {drag && dropAt === i ? <View style={{ height: 3, backgroundColor: SELECT, borderRadius: 2 }} /> : null}
            {frame(i, <BlockPreview b={b} kit={kit} logo={logo} pt={pt} accent={accent} ink={ink} layout={layout} />)}
          </React.Fragment>
        ))}
        {drag && dropAt === 'end' ? <View style={{ height: 3, backgroundColor: SELECT, borderRadius: 2 }} /> : null}
      </View>
      {footer ? <View style={{ position: 'absolute', left: pad, right: pad, bottom: Math.max(4, pad / 2) }}>{frame(footer.i, (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          {kit?.footer_text ? <T size={Math.max(4, pt * 8)} color={ink} numberOfLines={1} style={{ flex: 1 }}>{kit.footer_text}</T> : <Bar w="40%" h={Math.max(3, pt * 5)} />}
          <T size={Math.max(4, pt * 8)} color={ink}>Page 1 of 1</T>
        </View>
      ))}</View> : null}
    </View>
  );
}

const reorder = (layout, from, toFlow) => {
  const idxFlow = layout.blocks.map((b, i) => i).filter((i) => layout.blocks[i].type !== 'footer');
  const moving = layout.blocks[from];
  const rest = idxFlow.filter((i) => i !== from).map((i) => layout.blocks[i]);
  rest.splice(Math.max(0, Math.min(toFlow, rest.length)), 0, moving);
  return { ...layout, blocks: [...rest, ...layout.blocks.filter((b) => b.type === 'footer')] };
};

/** Full-screen template editor. `tpl` is an existing draft (create it first); `kits` are the kits usable for this template's owner. */
export function TemplateEditor({ tpl, kits, pickedKit, onClose, onNewKit, onPublished }) {
  const { toast } = useSession();
  const L = useLayout();
  const ins = useSafeAreaInsets();
  const wide = L.width >= 900;
  const [name, setName] = useState(tpl.name);
  const [kitId, setKitId] = useState(tpl.kit_id ?? null);
  const [layout, setLayout] = useState(() => clone(tpl.draft));
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [sel, setSel] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('Saved');
  const [busy, setBusy] = useState(false);
  const rv = useRef(tpl.row_version);
  const dirty = useRef(false);
  const chain = useRef(Promise.resolve());
  const lastText = useRef(null);
  const kit = kits.find((k) => k.id === kitId) ?? null;
  const logo = useLogo(kit);
  const fixed = REQUIRED[tpl.family] ?? [];
  const blocks = layout.blocks;
  const valid = name.trim() && blocks.every((b) => b.type !== 'text' || b.text?.trim()) && fixed.every((t) => blocks.some((b) => b.type === t));

  useEffect(() => { if (pickedKit && pickedKit !== kitId) { dirty.current = true; setKitId(pickedKit); } }, [pickedKit]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next, key) => {
    if (!(key && lastText.current === key)) setPast((p) => [...p.slice(-40), layout]);
    lastText.current = key ?? null;
    setFuture([]); dirty.current = true; setLayout(next);
  };
  const undo = () => { if (!past.length) return; setFuture((f) => [layout, ...f]); setLayout(past[past.length - 1]); setPast((p) => p.slice(0, -1)); dirty.current = true; lastText.current = null; setSel(null); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, layout]); setLayout(future[0]); setFuture((f) => f.slice(1)); dirty.current = true; lastText.current = null; setSel(null); };

  const save = () => {
    chain.current = chain.current.then(async () => {
      if (!dirty.current || !valid) return;
      setStatus('Saving…');
      try {
        const saved = await api.patch(`/document-templates/${tpl.id}`, { row_version: rv.current, name: name.trim(), kit_id: kitId, layout });
        rv.current = saved.row_version; dirty.current = false; setStatus('Saved');
      } catch (e) { setStatus(e.status === 409 ? 'Changed elsewhere: close and reopen' : 'Not saved'); toast(e.message); throw e; }
    }).catch(() => {});
    return chain.current;
  };
  useEffect(() => {
    if (!dirty.current) return undefined;
    if (!valid) { setStatus(name.trim() ? 'Add text to the empty text block to save' : 'Give the template a name'); return undefined; }
    setStatus('Unsaved changes');
    const t = setTimeout(save, 900);
    return () => clearTimeout(t);
  }, [layout, kitId, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch, key) => commit({ ...layout, ...patch }, key);
  const setBlock = (i, patch, key) => commit({ ...layout, blocks: blocks.map((b, n) => (n === i ? { ...b, ...patch } : b)) }, key);
  const flowIdx = blocks.map((b, i) => i).filter((i) => blocks[i].type !== 'footer');
  const step = (i, d) => { const at = flowIdx.indexOf(i); if (at < 0) return; commit(reorder(layout, i, at + d)); };
  const remove = (i) => { commit({ ...layout, blocks: blocks.filter((_, n) => n !== i) }); setSel(null); };
  const add = (type) => { commit({ ...layout, blocks: [...blocks, type === 'text' ? { type, text: '' } : { type }] }); setSel(blocks.length); };

  const preview = async () => {
    try {
      const blob = await api.postBlob('/branded-documents/preview', { layout, ...(kitId ? { kit_id: kitId } : {}) });
      if (Platform.OS === 'web') { const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); } else toast('Open the web app to preview the PDF');
    } catch (e) { toast(e.message); }
  };
  const publish = async () => {
    setBusy(true);
    try { await save(); if (dirty.current) throw new Error('Fix the highlighted problem first'); await api.post(`/document-templates/${tpl.id}/publish`, { row_version: rv.current }); onPublished(); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const close = async () => { if (dirty.current && valid) await save(); onClose(); };

  const b = sel != null ? blocks[sel] : null;
  const canW = wide ? Math.min(560, L.width - 440) : L.width - 32;

  const panel = (
    <View style={{ gap: 12 }}>
      {b ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" style={{ flex: 1 }}>{LABEL[b.type]}{fixed.includes(b.type) ? '  ·  required' : ''}</T>
            <Btn small title="Done" color={c.paper} ink={c.ink} onPress={() => setSel(null)} />
          </View>
          {b.type !== 'footer' ? <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title="↑ Up" color={c.paper} ink={c.ink} disabled={flowIdx.indexOf(sel) <= 0} onPress={() => step(sel, -1)} />
            <Btn small title="↓ Down" color={c.paper} ink={c.ink} disabled={flowIdx.indexOf(sel) >= flowIdx.length - 1} onPress={() => step(sel, 1)} />
          </View> : <T size={12} color={c.mute}>The footer sits at the bottom of every page. Its text comes from the brand kit.</T>}
          {b.type === 'text' ? (
            <>
              <Field value={b.text ?? ''} onChangeText={(x) => setBlock(sel, { text: x }, `t${sel}`)} multiline maxLength={2000} placeholder="Plain text, e.g. payment terms" />
              <T weight="800" size={13}>Align</T>
              <Seg options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} value={b.align ?? 'left'} onChange={(x) => setBlock(sel, { align: x })} />
              <T weight="800" size={13}>Size</T>
              <Seg options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} value={b.size ?? 'normal'} onChange={(x) => setBlock(sel, { size: x })} />
              <Btn small title="Duplicate" color={c.violet} onPress={() => commit({ ...layout, blocks: [...blocks.slice(0, sel + 1), { ...b }, ...blocks.slice(sel + 1)] })} style={{ alignSelf: 'flex-start' }} />
            </>
          ) : null}
          {b.type !== 'text' && !fixed.includes(b.type) ? <T size={12} color={c.mute}>Names and logo come from the brand kit; numbers come from the invoice.</T> : null}
          {fixed.includes(b.type) ? <T size={12} color={c.mute}>Numbers, names and amounts come from the invoice itself, so this section can move but not be removed.</T> : <Btn small title="Remove from page" color={c.paper} ink={c.red} onPress={() => remove(sel)} style={{ alignSelf: 'flex-start' }} />}
        </>
      ) : (
        <>
          <T weight="800" size={13}>Look</T>
          <Seg options={[{ value: 'classic', label: 'Classic' }, { value: 'modern', label: 'Modern' }]} value={layout.style} onChange={(x) => edit({ style: x })} />
          <T weight="800" size={13}>Paper</T>
          <Seg options={['A4', 'Letter']} value={layout.paper} onChange={(x) => edit({ paper: x })} />
          <T weight="800" size={13}>Orientation</T>
          <Seg options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} value={layout.orientation} onChange={(x) => edit({ orientation: x })} />
          <Counter label="Page margin" value={layout.margin_mm} onChange={(x) => edit({ margin_mm: x })} min={10} max={30} suffix="mm" />
          <T weight="800" size={13}>Brand kit</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label="None" active={!kitId} onPress={() => { dirty.current = true; setKitId(null); }} />
            {kits.map((k) => <Chip key={k.id} label={k.name} active={k.id === kitId} onPress={() => { dirty.current = true; setKitId(k.id); }} />)}
            <Chip label="+ New kit" active={false} onPress={onNewKit} />
          </View>
          <T weight="800" size={13}>Add to page</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {['text', 'header', 'footer', ...fixed].filter((t, i, a) => a.indexOf(t) === i && (t === 'text' || !blocks.some((x) => x.type === t))).map((t) => <Chip key={t} label={`+ ${LABEL[t]}`} active={false} onPress={() => add(t)} />)}
          </View>
          <T size={12} color={c.mute}>Tap a section on the page to edit or move it.</T>
        </>
      )}
    </View>
  );

  const bar = (
    <View style={{ backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line, paddingTop: ins.top + 8, paddingBottom: 6, paddingHorizontal: 12, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Btn small title="‹ Back" color={c.paper} ink={c.ink} onPress={close} />
        <TextInput value={name} onChangeText={(x) => { dirty.current = true; setName(x); }} maxLength={80} accessibilityLabel="Template name" placeholder="Template name" placeholderTextColor={c.mute} style={{ flex: 1, minWidth: 80, fontWeight: '700', fontSize: 16, color: c.ink, paddingVertical: 4, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }} />
        <Btn small title="↶" color={c.paper} ink={c.ink} disabled={!past.length} onPress={undo} accessibilityLabel="Undo" />
        <Btn small title="↷" color={c.paper} ink={c.ink} disabled={!future.length} onPress={redo} accessibilityLabel="Redo" />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T size={11} color={status === 'Saved' ? c.mute : c.sun} style={{ flex: 1 }} numberOfLines={2}>{status}</T>
        <Btn small title="Preview PDF" color={c.violet} onPress={preview} disabled={!valid} />
        <Btn small title="Publish" color={c.mint} ink={c.ink} onPress={publish} loading={busy} disabled={!valid} />
      </View>
    </View>
  );

  const page = (
    <View style={{ alignItems: 'center', padding: 16, paddingTop: 22, paddingBottom: wide ? 40 : 24 }}>
      {!kit && !kits.length ? <Pressable onPress={onNewKit} style={{ width: canW, marginBottom: 10, padding: 10, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.violet, backgroundColor: c.violetSoft }}><T size={13} weight="700" color={c.violet}>Add your logo and colours: create a brand kit</T></Pressable> : null}
      <PageCanvas layout={layout} kit={kit} logo={logo} width={canW} selected={sel} onSelect={(i) => setSel(i === sel ? null : i)} onReorder={(from, to) => { commit(reorder(layout, from, to)); setSel(Math.min(Math.max(to, 0), flowIdx.length - 1)); }} onDragging={setDragging} />
    </View>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#EEF0F4' }}>
        {bar}
        <View style={{ flex: 1, flexDirection: wide ? 'row' : 'column' }}>
          <ScrollView scrollEnabled={!dragging} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>{page}</ScrollView>
          {wide
            ? <ScrollView style={{ width: 340, flexGrow: 0, flexShrink: 0, backgroundColor: c.paper, borderLeftWidth: 1, borderColor: c.line }} contentContainerStyle={{ padding: 16 }}>{panel}</ScrollView>
            : <ScrollView style={{ maxHeight: Math.round(L.height * 0.36), backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line, flexGrow: 0 }} contentContainerStyle={{ padding: 14, paddingBottom: 14 + ins.bottom }} keyboardShouldPersistTaps="handled">{panel}</ScrollView>}
        </View>
      </View>
    </Modal>
  );
}

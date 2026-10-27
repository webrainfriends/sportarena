import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { Btn, T } from './ui';
import { c } from './theme';

// Evidence files and downloads that behave the same on iOS, iPadOS, Android and the web: pick a photo or a PDF, save text such as a CSV, open a file the
// API returned as base64. The server is the authority on type and size (PDF, JPEG, PNG, WebP; 5 MB); these only fail early with a plain message.
export const MAX_BYTES = 5 * 2 ** 20;
const WEB = Platform.OS === 'web' && typeof document !== 'undefined';
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
// tender and contract documents: also Word and Excel (macro-free), up to 10 MB; the server checks the content, not the name
const DOCS = { types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', MIME.docx, MIME.xlsx], accept: '.pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/jpeg,image/png,image/webp', max: 10 * 2 ** 20 };
const mimeOf = (name = '', hint) => hint ?? MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream';
const tooBig = (bytes, max = MAX_BYTES) => { if (bytes > max) throw new Error(`That file is over ${max / 2 ** 20} MB. Choose a smaller file.`); };
const toBase64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(new Error('That file could not be read')); r.readAsDataURL(blob); });

/** Pick one file: `source` is 'camera' (phones and tablets only), 'photos' or 'files'. Resolves { file_name, data (base64), type } or null when cancelled. */
export async function pickEvidence(source = 'files', { documents = false } = {}) {
  const max = documents ? DOCS.max : MAX_BYTES;
  if (WEB) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = documents ? DOCS.accept : 'application/pdf,image/jpeg,image/png,image/webp';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        try { tooBig(f.size, max); resolve({ file_name: f.name, data: await toBase64(f), type: f.type || mimeOf(f.name) }); } catch (e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }
  if (source === 'files') {
    const DocumentPicker = await import('expo-document-picker');
    const r = await DocumentPicker.getDocumentAsync({ type: documents ? DOCS.types : ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets?.[0]) return null;
    const a = r.assets[0]; tooBig(a.size ?? 0, max);
    const { File } = await import('expo-file-system');
    return { file_name: a.name, data: await new File(a.uri).base64(), type: mimeOf(a.name, a.mimeType) };
  }
  const ImagePicker = await import('expo-image-picker');
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error(source === 'camera' ? 'Allow camera access in Settings to take a photo, or choose a file instead.' : 'Allow photo access in Settings, or choose a file instead.');
  const r = await (source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync)({ mediaTypes: ['images'], quality: 0.7, base64: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  tooBig(Math.ceil(((a.base64 ?? '').length * 3) / 4));
  return { file_name: a.fileName ?? `photo-${Date.now()}.jpg`, data: a.base64, type: a.mimeType ?? 'image/jpeg' };
}

/** Pick a CSV / text / JSON file and return its text (timing exports, entry lists). Same on the web, iOS, iPadOS and Android. Resolves { name, text } or null when cancelled. */
export async function pickText() {
  const LIMIT = 4 * 2 ** 20;
  if (WEB) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.csv,.txt,.tsv,.json,text/csv,text/plain,application/json';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        if (f.size > LIMIT) return reject(new Error('That file is over 4 MB. Split it into smaller files.'));
        try { resolve({ name: f.name, text: await f.text() }); } catch (e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const r = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/json'], copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  if ((a.size ?? 0) > LIMIT) throw new Error('That file is over 4 MB. Split it into smaller files.');
  const { File } = await import('expo-file-system');
  return { name: a.name, text: await new File(a.uri).text() };
}

/** Save or share text (a CSV): the web downloads it; a phone or tablet writes it to the cache and opens the share sheet. */
export async function saveText(name, text, type = 'text/csv') {
  if (WEB) { const u = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); return; }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true }); f.write(text);
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot share files from here. Export from the web app.');
  await Sharing.shareAsync(f.uri, { mimeType: type, dialogTitle: name });
}

/** Open a file the API returned as { file_name, content_type, data (base64) }: a tab on the web, the share / open sheet on a device. */
export async function openBase64(file) {
  if (WEB) {
    const bytes = Uint8Array.from(atob(file.data), (ch) => ch.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: file.content_type })); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 120000); return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, file.file_name.replace(/[^\w. -]/g, '_'));
  f.create({ overwrite: true }); f.write(Uint8Array.from(atob(file.data), (ch) => ch.charCodeAt(0)));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here. Open the agreement on the web app.');
  await Sharing.shareAsync(f.uri, { mimeType: file.content_type, dialogTitle: file.file_name });
}

/** A form control: add up to `max` photos or documents, see what is attached, remove one. The value is [{ file_name, data, type }]. */
export function EvidenceField({ label, value = [], onChange, max = 3 }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const add = async (source) => {
    setErr(null); setBusy(true);
    try { const f = await pickEvidence(source); if (f) onChange([...value, f]); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const full = value.length >= max;
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      {value.map((f, n) => (
        <View key={`${f.file_name}-${n}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <T size={12} style={{ flex: 1 }}>{f.file_name} · {Math.max(1, Math.round(((f.data?.length ?? 0) * 3) / 4 / 1024))} KB</T>
          <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => onChange(value.filter((_, i) => i !== n))} accessibilityLabel={`Remove ${f.file_name}`} />
        </View>))}
      {!full ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {Platform.OS === 'web' ? <Btn small title="Choose a photo or PDF" color={c.paper} ink={c.ink} onPress={() => add('files')} loading={busy} />
            : <>
              <Btn small title="Take a photo" color={c.paper} ink={c.ink} onPress={() => add('camera')} loading={busy} />
              <Btn small title="Choose a photo" color={c.paper} ink={c.ink} onPress={() => add('photos')} loading={busy} />
              <Btn small title="Choose a PDF" color={c.paper} ink={c.ink} onPress={() => add('files')} loading={busy} />
            </>}
        </View>) : <T size={12} color={c.mute}>You can attach up to {max} files.</T>}
      <T size={12} color={c.mute}>PDF, JPEG, PNG or WebP, up to 5 MB each. Do not attach health records.</T>
      {err ? <T size={12} color={c.red} accessibilityRole="alert">{err}</T> : null}
    </View>
  );
}

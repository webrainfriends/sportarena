// Open a protected PDF (it needs the sign-in header, so it is fetched as a blob). The web opens a tab; a phone saves the file to its cache
// and hands it to the share / open sheet.
import { Platform } from 'react-native';
import { api } from './api';

export async function openPdf(path, name = 'document') {
  return openBlob(await api.download(path), name, 'pdf');
}

/** Fetch a protected file (it needs the sign-in header) and open it: a tab on the web, the share / open sheet on a phone or tablet. */
export async function openProtected(path, name = 'document') {
  return openBlob(await api.download(path), name);
}

/** Open a blob already in hand. The file extension follows its type unless one is given. */
export async function openBlob(blob, name = 'document', ext) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const kind = ext ?? (/pdf/.test(blob.type) ? 'pdf' : /png/.test(blob.type) ? 'png' : /webp/.test(blob.type) ? 'webp' : /gif/.test(blob.type) ? 'gif' : /^image\//.test(blob.type) ? 'jpg' : 'pdf');
  const file = new File(Paths.cache, `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.${kind}`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open files from here.');
  const mimeType = kind === 'pdf' ? 'application/pdf' : (blob.type || `image/${kind}`);
  await Sharing.shareAsync(file.uri, { mimeType, ...(kind === 'pdf' ? { UTI: 'com.adobe.pdf' } : {}), dialogTitle: name });
}

/** Save or share an export returned by the API ({ filename, content_type, encoding, content }). The web downloads it; a phone writes it to its cache and opens the share sheet. */
export async function saveExport(out) {
  const bytes = out.encoding === 'base64' ? Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(out.content);
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: out.content_type }));
    a.download = out.filename;
    a.click();
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, out.filename.replace(/[^A-Za-z0-9._-]/g, '_'));
  file.create({ overwrite: true });
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot share files from here.');
  await Sharing.shareAsync(file.uri, { mimeType: out.content_type.split(';')[0], dialogTitle: out.filename });
}

/**
 * Hand an export to another app: on a phone or tablet the share sheet (WhatsApp, Messages, Mail, Drive…); in a browser the system share dialog with the
 * file where it is supported, otherwise the file is downloaded and WhatsApp opens with the message ready, so the file only has to be attached.
 * @returns {Promise<'shared'|'downloaded'>}
 */
export async function shareExport(out, message = '') {
  if (Platform.OS !== 'web' || typeof document === 'undefined') { await saveExport(out); return 'shared'; }
  const bytes = out.encoding === 'base64' ? Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(out.content);
  const file = typeof File !== 'undefined' ? new File([bytes], out.filename, { type: out.content_type.split(';')[0] }) : null;
  if (file && typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: message, title: out.filename }); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'shared'; }
  }
  await saveExport(out);
  if (typeof window !== 'undefined') window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
  return 'downloaded';
}

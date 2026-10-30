// Open a protected PDF (it needs the sign-in header, so it is fetched as a blob). The web opens a tab; a phone saves the file to its cache
// and hands it to the share / open sheet.
import { Platform } from 'react-native';
import { api } from './api';

export async function openPdf(path, name = 'document') {
  const blob = await api.download(path);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open PDF files from here. Open the PDF in the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: name });
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
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot share files from here. Open the web app to download it.');
  await Sharing.shareAsync(file.uri, { mimeType: out.content_type.split(';')[0], dialogTitle: out.filename });
}

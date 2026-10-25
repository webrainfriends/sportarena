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

// Logo checks done on the actual bytes: type, dimensions (read from the header, never decoded) and size, so a hostile image cannot be a
// decompression bomb. SVG/HTML are refused outright, and WebP is not accepted yet because the PDF renderer cannot embed it.
export const LOGO_LIMITS = { bytes: 2 * 2 ** 20, maxPx: 4000, minPx: 32, recommendedPx: 300 };

export function inspectLogo(b) {
  if (b.length >= 24 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && b.subarray(12, 16).toString('latin1') === 'IHDR')
    return { type: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b.subarray(0, 3).toString('hex') === 'ffd8ff') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'image/jpeg', ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

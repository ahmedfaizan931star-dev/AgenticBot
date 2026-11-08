/**
 * Zip-bomb guard for DOCX: reads the central directory (without inflating anything) and
 * reports the claimed total uncompressed size and entry count.
 */
export function inspectZip(buf: Uint8Array): { ok: true; entries: number; uncompressed: number } | { ok: false } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false };
  const entries = v.getUint16(eocd + 10, true);
  let offset = v.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buf.length || v.getUint32(offset, true) !== 0x02014b50) return { ok: false };
    total += v.getUint32(offset + 24, true);
    offset += 46 + v.getUint16(offset + 28, true) + v.getUint16(offset + 30, true) + v.getUint16(offset + 32, true);
  }
  return { ok: true, entries, uncompressed: total };
}

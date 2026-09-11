/**
 * Minimal PNG / JPEG header readers. No dependency, no decoding — just enough
 * to assert that a generated file is the size it claims to be.
 */

import { readFileSync } from 'node:fs';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function imageSize(file) {
  const buf = readFileSync(file);

  if (buf.length > 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${file}: PNG without IHDR first`);
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  }

  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          type: 'jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          bytes: buf.length,
        };
      }
      i += 2 + len;
    }
    throw new Error(`${file}: JPEG with no SOF marker`);
  }

  if (buf.length > 5 && buf.toString('utf8', 0, 400).includes('<svg')) {
    const vb = buf.toString('utf8', 0, 2000).match(/viewBox="([\d.\s-]+)"/);
    if (vb) {
      const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
      return { type: 'svg', width: w, height: h, bytes: buf.length };
    }
    return { type: 'svg', width: null, height: null, bytes: buf.length };
  }

  throw new Error(`${file}: unrecognised image format`);
}

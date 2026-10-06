// The router speaks CESU-8 for characters outside the BMP: each UTF-16
// surrogate is encoded on its own as a 3-byte sequence (huawei-lte-api's
// cesu8_encode / cesu8_fix). Standard UTF-8 tooling does not understand it.

const encoder = new TextEncoder();

/** UTF-8, except that astral characters become two 3-byte surrogates. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function cesu8Encode(text: string): Bytes {
  // Without surrogates it is plain UTF-8.
  if (!/[\ud800-\udfff]/.test(text)) return encoder.encode(text) as Bytes;
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (isSurrogate) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(...encoder.encode(text[i] as string));
    }
  }
  return Uint8Array.from(out);
}

/** Rewrites CESU-8 surrogate pairs in `bytes` as proper 4-byte UTF-8. */
export function cesu8Fix(bytes: Uint8Array): Bytes {
  // Nearly every response has no CESU-8 pair: skip the copy.
  if (!bytes.includes(0xed)) return bytes as Bytes;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    if (
      b === 0xed &&
      i + 5 < bytes.length &&
      ((bytes[i + 1] as number) & 0xf0) === 0xa0 &&
      (bytes[i + 3] as number) === 0xed &&
      ((bytes[i + 4] as number) & 0xf0) === 0xb0
    ) {
      const hi =
        0xd000 |
        (((bytes[i + 1] as number) & 0x3f) << 6) |
        ((bytes[i + 2] as number) & 0x3f);
      const lo =
        0xd000 |
        (((bytes[i + 4] as number) & 0x3f) << 6) |
        ((bytes[i + 5] as number) & 0x3f);
      const cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      out.push(...encoder.encode(String.fromCodePoint(cp)));
      i += 5;
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

// Dependency-free ZIP writer (STORED / no compression).
//
// Enough to bundle a handful of text resources (study guide, practice questions,
// flashcards, a data CSV, code) into one .zip the user can download — without pulling
// in a zip library or bloating the client bundle. STORED entries are valid ZIP and open
// in every unzip tool; for small text payloads compression isn't worth the extra code.

const crcTable: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// Fixed, valid DOS timestamp (1980-01-01). Content is what matters here, not mtime.
const DOS_TIME = u16(0);
const DOS_DATE = u16(0x21);

export interface ZipEntry {
  name: string;
  content: string;
}

/** Build a valid STORED .zip from text entries. Returns a Blob ready for download. */
export const createZipBlob = (entries: ZipEntry[]): Blob => {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = enc.encode(e.content ?? '');
    const crc = crc32(data);
    const sizeU32 = u32(data.length);

    const local = concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), DOS_TIME, DOS_DATE,
      u32(crc), sizeU32, sizeU32, u16(nameBytes.length), u16(0),
      nameBytes, data
    );
    chunks.push(local);

    const cd = concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), DOS_TIME, DOS_DATE,
      u32(crc), sizeU32, sizeU32, u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes
    );
    central.push(cd);
    offset += local.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }

  chunks.push(
    concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(cdStart), u16(0))
  );

  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
};

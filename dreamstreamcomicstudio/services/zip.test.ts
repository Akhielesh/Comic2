// @vitest-environment node
// jsdom's Blob has no arrayBuffer(); Node (like every real browser) does. The zip writer
// itself is environment-agnostic — this only affects reading the bytes back in the test.
import { describe, it, expect } from 'vitest';
import { createZipBlob } from './zip';

// Verify the hand-rolled STORED zip is structurally valid: the right signatures in the
// right places, the correct entry count, and the entry names/content present in bytes.
// This guards the byte-field ordering (the easy thing to get wrong) from regressions.

const readU16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const readU32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const indexOfSig = (b: Uint8Array, sig: number) => {
  for (let i = 0; i + 4 <= b.length; i += 1) if (readU32(b, i) === sig) return i;
  return -1;
};

describe('createZipBlob', () => {
  it('produces a valid STORED zip with the entries and an end-of-central-directory record', async () => {
    const blob = createZipBlob([
      { name: 'notes.md', content: '# Hello\n\nworld' },
      { name: 'data.csv', content: 'a,b\n1,2\n' }
    ]);
    expect(blob.type).toBe('application/zip');
    const b = await bytesOf(blob);

    // Starts with a local file header.
    expect(readU32(b, 0)).toBe(0x04034b50);

    // End-of-central-directory record exists and reports 2 entries.
    const eocd = indexOfSig(b, 0x06054b50);
    expect(eocd).toBeGreaterThan(0);
    expect(readU16(b, eocd + 10)).toBe(2); // total entries

    // At least one central-directory header is present.
    expect(indexOfSig(b, 0x02014b50)).toBeGreaterThan(0);

    // Entry names + content survive into the bytes.
    const asText = new TextDecoder().decode(b);
    expect(asText).toContain('notes.md');
    expect(asText).toContain('data.csv');
    expect(asText).toContain('# Hello');
  });

  it('handles an empty entry list', async () => {
    const b = await bytesOf(createZipBlob([]));
    // Just the EOCD record (22 bytes) with zero entries.
    expect(b.length).toBe(22);
    expect(readU32(b, 0)).toBe(0x06054b50);
    expect(readU16(b, 10)).toBe(0);
  });
});

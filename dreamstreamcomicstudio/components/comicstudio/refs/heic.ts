// HEIC/HEIF, honestly (refs.md §7.4). Owner: P1-REFS.
//
// The iOS photo picker already transcodes HEIC to JPEG when `accept` lists JPEG/PNG and not
// image/heic — so the file input deliberately omits HEIC and most iPhone photos arrive as JPEG.
// A HEIC dropped from the Finder is decoded by the browser when it can (Safari can) and converted
// to WebP like any other photo; when the browser can't, the row says exactly what to do. No LGPL
// decoder (libheif) is shipped.

export const HEIC_HELP = "This browser can't read HEIC photos. Open it in Photos and choose Export → JPEG, or use Safari.";

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

export const isHeicType = (type: string | undefined): boolean => /^image\/hei[cf](-sequence)?$/i.test(type || '');
export const isHeicName = (name: string | undefined): boolean => /\.(heic|heif)$/i.test(name || '');

/** Read the first `n` bytes of a blob (Blob.arrayBuffer where available, else FileReader). */
export async function readHead(blob: Blob, n = 64): Promise<Uint8Array> {
  const part = blob.slice(0, n);
  if (typeof (part as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    return new Uint8Array(await part.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(part);
  });
}

/** ISO-BMFF `ftyp` brands → 'heic' | 'avif' | null (any other content). */
export function ftypKind(head: Uint8Array): 'heic' | 'avif' | null {
  if (head.length < 12) return null;
  const ascii = (from: number) => String.fromCharCode(head[from], head[from + 1], head[from + 2], head[from + 3]);
  if (ascii(4) !== 'ftyp') return null;
  const size = Math.min(((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0, head.length);
  const brands = [ascii(8)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
  if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic';
  return null;
}

/** HEIC by type, name or (when neither says) by its bytes. */
export async function isHeicFile(file: Blob & { name?: string }): Promise<boolean> {
  if (isHeicType(file.type) || isHeicName(file.name)) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  try {
    return ftypKind(await readHead(file)) === 'heic';
  } catch {
    return false;
  }
}

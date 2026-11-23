import { inspectOriginal, ORIGINAL_KEYS, type OriginalKey } from '../../server/src/comic/originals/book.js';
import { resolve } from 'node:path';

async function main() {
  const [mode, key, directory, ...rest] = process.argv.slice(2);
  if (!['check', 'publish'].includes(mode) || !ORIGINAL_KEYS.includes(key as OriginalKey) || !directory || rest.length) {
    throw new Error('Usage: tsx scripts/ops/studioOriginal.ts check|publish ' + ORIGINAL_KEYS.join('|') + ' <source-directory>');
  }
  const root = resolve(directory);
  if (mode === 'check') {
    const book = await inspectOriginal(root, key as OriginalKey);
    console.log(
      JSON.stringify({
        book: book.key,
        digest: book.digest,
        pages: book.metadata.pages.length,
        images: book.images.length,
        ...(book.metadata.orientation && {
          kind: book.metadata.kind,
          readingDirection: book.metadata.readingDirection,
          orientation: book.metadata.orientation,
          ...(book.metadata.colorMode && { colorMode: book.metadata.colorMode }),
          firstStoryPage: { width: book.images[1].width, height: book.images[1].height }
        }),
        bytes: book.images.reduce((n, i) => n + i.bytes, 0)
      })
    );
  } else {
    const { publishBundledOriginal } = await import('../../server/src/comic/originals/import.js');
    const { slug } = await publishBundledOriginal(key as OriginalKey, root);
    console.log(JSON.stringify({ book: key, path: '/c/' + slug }));
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Studio Originals operation failed.');
  process.exitCode = 1;
});

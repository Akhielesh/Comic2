import { MAX_IMAGE_ATTACHMENTS, MAX_INLINE_ATTACHMENT_CHARS } from '../shared/attachmentLimits';

/** Keep usable files in picker order. Unreadable/oversize files do not consume a slot. */
export async function readAttachmentBatch<T>(
  files: readonly File[], existingCount: number, existingChars: number,
  read: (file: File) => Promise<T>, dataUrlOf: (item: T) => string,
  maxChars = MAX_INLINE_ATTACHMENT_CHARS
): Promise<{ added: T[]; notice: string }> {
  const added: T[] = [];
  const messages: string[] = [];
  let chars = existingChars;
  for (const file of files) {
    if (existingCount + added.length >= MAX_IMAGE_ATTACHMENTS) {
      messages.push(`Up to ${MAX_IMAGE_ATTACHMENTS} attachments fit at once. Remove one to add another.`);
      break;
    }
    try {
      // Avoid reading a multi-gigabyte selection into memory just to reject it.
      if (Math.ceil(file.size / 3) * 4 > maxChars - chars) throw new Error(`${file.name} exceeds the remaining attachment space. Choose a smaller file.`);
      const item = await read(file);
      const length = dataUrlOf(item).length;
      if (length + chars > maxChars) throw new Error(`${file.name} exceeds the remaining attachment space. Choose a smaller file.`);
      chars += length;
      added.push(item);
    } catch (error) {
      messages.push(error instanceof Error ? error.message : `Could not read ${file.name}.`);
    }
  }
  return { added, notice: [...new Set(messages)].slice(0, 3).join(' ') };
}

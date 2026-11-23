// One picker batch or conversation turn. Project libraries can retain more across batches.
export const MAX_IMAGE_ATTACHMENTS = 10;
// Base64 data consumes four characters per three bytes. Leave room in the 10 MiB JSON body for the brief and metadata.
export const MAX_INLINE_ATTACHMENT_CHARS = 8 * 1024 * 1024;

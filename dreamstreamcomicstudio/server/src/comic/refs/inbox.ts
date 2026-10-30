// The ref inbox: composer uploads that are not sent or assigned yet (refs.md §4.4–§4.5).
// Owner: P1-REFS.
//
// The composer uploads each image to the inbox the moment it is added (POST /refs?to=inbox),
// so the message later carries only inbox PATHS. takeInbox moves them into the message's
// attachments; a path that is not in THIS project's inbox is refused (400), so a client can
// never smuggle another project's (or user's) storage path into a message.

import { refInboxOf, type ComicDoc, type RefAsset } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { REF_LIMITS } from '../../../../shared/comic/refs.js';
import { StudioError, type StudioContext } from '../types.js';

/** Inbox items older than REF_LIMITS.inboxTtlMs (never sent or assigned). */
export const expiredInboxPaths = (doc: ComicDoc, now: number): string[] =>
  refInboxOf(doc)
    .filter((r) => !!r?.path && typeof r.at === 'number' && Number.isFinite(r.at) && now - r.at > REF_LIMITS.inboxTtlMs)
    .map((r) => r.path);

/** `ref_remove` ops that prune expired inbox items (their files are left to storage retention). */
export const pruneInboxOps = (doc: ComicDoc, now: number): DocOp[] =>
  expiredInboxPaths(doc, now).map((path): DocOp => ({ op: 'ref_remove', owner: { kind: 'inbox' }, path }));

/** The op that drops one inbox item, or null when it is already gone (DELETE is idempotent). */
export const inboxRemoveOp = (doc: ComicDoc, path: string): DocOp | null =>
  typeof path === 'string' && refInboxOf(doc).some((r) => r.path === path) ? { op: 'ref_remove', owner: { kind: 'inbox' }, path } : null;

/**
 * Move images the composer uploaded to the inbox into this message's attachments
 * (ref_remove from the inbox; the message op then carries the RefAssets with their
 * metadata). Order follows the request. A path that is not in this project's inbox is
 * refused (400) — clients can never smuggle other paths.
 */
export async function takeInbox(ctx: StudioContext, inboxPaths: string[]): Promise<{ attachments: RefAsset[]; ops: DocOp[] }> {
  const list = Array.isArray(inboxPaths) ? inboxPaths : [];
  const unique = [...new Set(list.filter((p): p is string => typeof p === 'string' && !!p))];
  if (unique.length > REF_LIMITS.perMessageImages) {
    throw new StudioError('BAD_REQUEST', `Send up to ${REF_LIMITS.perMessageImages} images per message.`, { status: 400 });
  }
  const inbox = refInboxOf(ctx.session.doc);
  const attachments: RefAsset[] = [];
  const ops: DocOp[] = [];
  for (const path of unique) {
    const ref = inbox.find((r) => r.path === path);
    if (!ref) throw new StudioError('BAD_REQUEST', 'One of the images is no longer waiting to be sent — attach it again.', { status: 400 });
    attachments.push(ref);
    ops.push({ op: 'ref_remove', owner: { kind: 'inbox' }, path });
  }
  return { attachments, ops };
}

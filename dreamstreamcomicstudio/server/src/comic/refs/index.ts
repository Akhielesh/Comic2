// Multi-reference seams (contract §12.8, refs.md). Owner: P1-REFS (replaces the wave-0 stub in
// place: same names, same signatures).
//
//   addRefs                 honest adds: never past the caps, always says what happened
//   takeInbox               composer inbox → message attachments (foreign paths refused)
//   applyAttachmentTargets  composer quick-assign, committed before the director turn
//   carriedImages           unassigned images from the previous user turns (numbering continues)
//   refIntentHint           free regex pre-pass over the user's words ($0)
//
// The implementations live in the sibling files; this module is the stable import point.

export { addRefs, cleanFileName, cleanNote, imagesWord, limitMessage, numberRanges, ownerName, planRefAdds, plural, roomFor, upperName } from './addRefs.js';
export type { AddOpts, PlannedAdds } from './addRefs.js';
export { expiredInboxPaths, inboxRemoveOp, pruneInboxOps, takeInbox } from './inbox.js';
export { applyAttachmentTargets } from './attachmentTargets.js';
export { CARRY_WINDOW, carriedImages, imageSpan, unassignedImages, whoIsInTheseCard } from './carried.js';
export { analyzeAttachmentText, attachmentHint, refIntentHint } from './refIntent.js';
export type { AttachmentAnalysis } from './refIntent.js';

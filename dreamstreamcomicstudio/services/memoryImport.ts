// Client-side preparation for "import memories from another AI tool".
//
// Users bring memories in messy shapes: the copy-pasted Memory list from ChatGPT's
// personalization settings, a conversations.json from a ChatGPT/Claude data export,
// Gemini's saved-info list, or a hand-written notes file. This module reduces any of
// those to a bounded plain-text payload BEFORE it leaves the browser, so the server
// distiller (POST /api/chat/memory/import) receives signal, not megabytes of JSON
// scaffolding — and nothing irrelevant (assistant replies, ids, timestamps) is sent.
// JSON in which none of the user's own words can be found sends NOTHING: a layout we
// don't recognise is never sent raw, because its raw text would carry the assistant's
// replies (the privacy promise is "only the text you wrote"). A .jsonl export (one JSON
// value per line) is read the same way, line by line.

export type MemoryImportSource = 'chatgpt' | 'claude' | 'gemini' | 'other';

export const MEMORY_IMPORT_SOURCES: { id: MemoryImportSource; label: string; hint: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT', hint: 'Settings → Personalization → Memory ("Manage"), or a data-export file' },
  { id: 'claude', label: 'Claude', hint: 'Settings → your profile/preferences text, or a data-export file' },
  { id: 'gemini', label: 'Gemini', hint: '"Saved info" entries, or a Google Takeout file' },
  { id: 'other', label: 'Other', hint: 'Any notes or exported text about you' }
];

/** Server-side request cap (mirrors MAX_IMPORT_CONTENT_CHARS in routes/chat.ts). */
export const MAX_IMPORT_CHARS = 24_000;

/** Accept generous uploads — extraction shrinks them client-side before sending. */
export const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Keys whose value is the user's own memory or instruction text, wherever they sit.
 * (Chat turns are recognised structurally instead: ChatGPT message.author.role, Claude
 * chat_messages[].sender, a Gemini API contents[].role.)
 */
const MEMORY_KEYS = new Set([
  'memory', 'memories', 'about_user_message', 'about_model_message',
  'instructions', 'custom_instructions', 'saved_info', 'preference'
]);

/**
 * Generic text keys. Every export uses them for the assistant's answers as much as for
 * the user's words, so they are harvested only once the walk is anchored: inside a
 * user-authored turn or under a memory key. Under any other key (`response.text`,
 * `answer.content`, a flat `{q, text}` pair) they are not the user's, and nothing of
 * them is collected.
 */
const GENERIC_TEXT_KEYS = new Set(['content', 'text', 'value']);

const IGNORED_KEYS = new Set([
  'id', 'uuid', 'conversation_id', 'parent', 'children', 'create_time', 'update_time',
  'created_at', 'updated_at', 'timestamp', 'model', 'model_slug', 'url', 'href', 'image',
  'attachments', 'metadata', 'status', 'recipient', 'channel', 'weight', 'end_turn', 'index',
  'role', 'sender', 'author', 'name', 'slug',
  // Labels and pointers inside a user turn (ChatGPT content.content_type and image
  // asset_pointer; Claude content[].type and its start/stop timestamps): not words.
  'content_type', 'type', 'asset_pointer', 'start_timestamp', 'stop_timestamp',
  // ChatGPT code turns: content.language ('unknown', 'python', …) is a label, not words.
  'language'
]);

const looksLikeAssistantRole = (value: unknown): boolean =>
  typeof value === 'string' && ['assistant', 'model', 'system', 'tool', 'ai'].includes(value.toLowerCase());

const looksLikeUserRole = (value: unknown): boolean =>
  typeof value === 'string' && ['user', 'human'].includes(value.toLowerCase());

/**
 * Google Takeout "My Activity" titles that hold the user's own words after a fixed
 * prefix: a Gemini (or Bard) prompt, and a search the user typed. Only the English
 * prefixes are known; a title in another language, or any other entry ("Visited …",
 * "Watched …", "Used Gemini Apps"), is not separable and is skipped.
 */
const TAKEOUT_OWN_WORDS_PREFIXES = ['Prompted ', 'Searched for '] as const;

/**
 * A Google Takeout "My Activity" record is {header, title, time, …} (all strings). Its
 * `safeHtmlItem` holds the assistant's answer and `subtitles`/`details` hold page and
 * product names, so only the title's text after a known prefix is the user's: returns
 * that text, `null` for a Takeout record with none (nothing of it is collected), or
 * `undefined` when the record is not Takeout-shaped (walk it as usual).
 */
const takeoutOwnWords = (record: Record<string, unknown>): string | null | undefined => {
  const { header, title, time } = record;
  if (typeof header !== 'string' || typeof title !== 'string' || typeof time !== 'string') return undefined;
  const prefix = TAKEOUT_OWN_WORDS_PREFIXES.find((p) => title.startsWith(p));
  return prefix ? title.slice(prefix.length).trim() : null;
};

/**
 * Walk arbitrary exported JSON and collect the user's OWN text: memory entries,
 * custom instructions, and user-authored messages. Assistant/model output is
 * skipped — importing the bot's words as facts about the user is how an import
 * feature poisons a memory store.
 *
 * `allowed` gates harvesting: it turns ON inside a user-authored turn or under a
 * memory key, and OFF again when descending through unknown object keys — so a bare
 * list of memory strings imports cleanly while ids/titles/slugs stay behind.
 *
 * `anchored` records that the walk has passed through a user-authored turn or a memory
 * key on the way here. Only then do the generic text keys (GENERIC_TEXT_KEYS) turn
 * `allowed` back on: in a layout with no such anchor, `text`/`content`/`value` are as
 * likely to hold the assistant's answer as the user's prompt, so neither is sent.
 */
const collectUserText = (
  node: unknown,
  out: string[],
  roleHint: 'user' | 'assistant' | null,
  allowed: boolean,
  depth: number,
  anchored = false
): void => {
  if (out.length >= 800 || depth > 12 || node == null) return;

  if (typeof node === 'string') {
    const text = node.trim();
    if (text.length >= 3 && allowed && roleHint !== 'assistant') out.push(text);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUserText(item, out, roleHint, allowed, depth + 1, anchored);
    return;
  }
  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;

  // Google Takeout activity entry: its title's prompt or search is the user's; nothing
  // else in it is (the answer sits in safeHtmlItem), so it is never walked.
  const takeout = takeoutOwnWords(record);
  if (takeout !== undefined) {
    if (takeout && takeout.length >= 3 && roleHint !== 'assistant') out.push(takeout);
    return;
  }

  // Role detection for chat-log shapes (ChatGPT: author.role; Claude: sender).
  let nextRole = roleHint;
  const role = record.role ?? record.sender ?? (record.author as Record<string, unknown> | undefined)?.role;
  if (looksLikeAssistantRole(role)) nextRole = 'assistant';
  else if (looksLikeUserRole(role)) nextRole = 'user';

  for (const [key, value] of Object.entries(record)) {
    if (IGNORED_KEYS.has(key)) continue;
    const childAnchored = anchored || nextRole === 'user' || MEMORY_KEYS.has(key);
    const childAllowed =
      nextRole !== 'assistant' &&
      (nextRole === 'user' || MEMORY_KEYS.has(key) || (GENERIC_TEXT_KEYS.has(key) && childAnchored));
    collectUserText(value, out, nextRole, childAllowed, depth + 1, childAnchored);
  }
};

/**
 * JSON Lines (a .jsonl export): one JSON object or array per line. Returns each line's
 * parsed value, or `null` unless there are at least two non-empty lines and EVERY one of
 * them is an object or an array that parses on its own. A cut-off export, a markdown
 * checklist ("[x] …") or prose that merely starts with a bracket fails that test and
 * stays plain text.
 */
const parseJsonLines = (text: string): unknown[] | null => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const values: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) return null;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      return null;
    }
  }
  return values;
};

/**
 * Normalize pasted or uploaded content to a bounded plain-text payload.
 * JSON (an object or array) gets the user-text extraction, and JSON in which none of the
 * user's own words is found returns '' so nothing is sent. JSON Lines gets the same
 * extraction, line by line, so a .jsonl chat export sends the user's turns and never the
 * assistant's. Anything else (plain text, markdown, or text that only looks like JSON and
 * parses neither whole nor line by line) passes through trimmed: that last case is sent
 * as written, whatever it holds, so a cut-off conversations.json keeps its assistant
 * lines (text that is not JSON stays text).
 */
export const prepareMemoryImportContent = (raw: string): string => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let roots: unknown[];
    try {
      roots = [JSON.parse(trimmed) as unknown];
    } catch {
      // Not one JSON value. JSON Lines is read line by line (each line is its own root);
      // anything else is not JSON at all and is treated as plain text.
      const lines = parseJsonLines(trimmed);
      if (!lines) return trimmed.slice(0, MAX_IMPORT_CHARS);
      roots = lines;
    }
    const out: string[] = [];
    // Each root starts `allowed` so a bare array/string export (e.g. Gemini saved info
    // copied as JSON) imports directly; object keys re-gate from there. The 800-piece
    // cap is shared across the lines of a .jsonl file (collectUserText stops at it).
    for (const root of roots) collectUserText(root, out, null, true, 0);
    // JSON with nothing user-authored sends nothing: its raw text is the assistant's
    // replies and the export's scaffolding, never the user's own words.
    return [...new Set(out)].join('\n').slice(0, MAX_IMPORT_CHARS);
  }
  return trimmed.slice(0, MAX_IMPORT_CHARS);
};

/**
 * The calm notice when a non-empty file or paste holds none of the user's own words
 * (prepareMemoryImportContent returned ''): the import is not called.
 */
export const memoryImportNothingFoundNotice = (fromFile: boolean): string =>
  `We couldn't find your own words in that ${fromFile ? 'file' : 'text'}, so nothing was sent.`;

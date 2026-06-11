// Client-side preparation for "import memories from another AI tool".
//
// Users bring memories in messy shapes: the copy-pasted Memory list from ChatGPT's
// personalization settings, a conversations.json from a ChatGPT/Claude data export,
// Gemini's saved-info list, or a hand-written notes file. This module reduces any of
// those to a bounded plain-text payload BEFORE it leaves the browser, so the server
// distiller (POST /api/chat/memory/import) receives signal, not megabytes of JSON
// scaffolding — and nothing irrelevant (assistant replies, ids, timestamps) is sent.

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

const KNOWN_USER_TEXT_KEYS = new Set([
  // ChatGPT export (conversations.json): message.author.role === 'user' handled
  // structurally below; these keys catch memory/instruction shapes.
  'memory', 'memories', 'content', 'text', 'about_user_message', 'about_model_message',
  // Claude export: chat_messages[].text with sender 'human' handled structurally.
  'instructions', 'custom_instructions', 'saved_info', 'preference', 'value'
]);

const IGNORED_KEYS = new Set([
  'id', 'uuid', 'conversation_id', 'parent', 'children', 'create_time', 'update_time',
  'created_at', 'updated_at', 'timestamp', 'model', 'model_slug', 'url', 'href', 'image',
  'attachments', 'metadata', 'status', 'recipient', 'channel', 'weight', 'end_turn', 'index',
  'role', 'sender', 'author', 'name', 'slug'
]);

const looksLikeAssistantRole = (value: unknown): boolean =>
  typeof value === 'string' && ['assistant', 'model', 'system', 'tool', 'ai'].includes(value.toLowerCase());

const looksLikeUserRole = (value: unknown): boolean =>
  typeof value === 'string' && ['user', 'human'].includes(value.toLowerCase());

/**
 * Walk arbitrary exported JSON and collect the user's OWN text: memory entries,
 * custom instructions, and user-authored messages. Assistant/model output is
 * skipped — importing the bot's words as facts about the user is how an import
 * feature poisons a memory store.
 *
 * `allowed` gates harvesting: it turns ON inside a user-authored turn or under a
 * memory-ish key, and OFF again when descending through unknown object keys — so a
 * bare list of memory strings imports cleanly while ids/titles/slugs stay behind.
 */
const collectUserText = (
  node: unknown,
  out: string[],
  roleHint: 'user' | 'assistant' | null,
  allowed: boolean,
  depth: number
): void => {
  if (out.length >= 800 || depth > 12 || node == null) return;

  if (typeof node === 'string') {
    const text = node.trim();
    if (text.length >= 3 && allowed && roleHint !== 'assistant') out.push(text);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUserText(item, out, roleHint, allowed, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;

  // Role detection for chat-log shapes (ChatGPT: author.role; Claude: sender).
  let nextRole = roleHint;
  const role = record.role ?? record.sender ?? (record.author as Record<string, unknown> | undefined)?.role;
  if (looksLikeAssistantRole(role)) nextRole = 'assistant';
  else if (looksLikeUserRole(role)) nextRole = 'user';

  for (const [key, value] of Object.entries(record)) {
    if (IGNORED_KEYS.has(key)) continue;
    const childAllowed = nextRole !== 'assistant' && (nextRole === 'user' || KNOWN_USER_TEXT_KEYS.has(key));
    collectUserText(value, out, nextRole, childAllowed, depth + 1);
  }
};

/**
 * Normalize pasted or uploaded content to a bounded plain-text payload.
 * JSON gets the user-text extraction; anything else passes through trimmed.
 */
export const prepareMemoryImportContent = (raw: string): string => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const out: string[] = [];
      // Root starts `allowed` so a bare array/string export (e.g. Gemini saved info
      // copied as JSON) imports directly; object keys re-gate from there.
      collectUserText(parsed, out, null, true, 0);
      const deduped = [...new Set(out)];
      if (deduped.length > 0) return deduped.join('\n').slice(0, MAX_IMPORT_CHARS);
      // JSON with nothing user-authored: fall through to raw (it may still be useful).
    } catch {
      /* not valid JSON — treat as plain text */
    }
  }
  return trimmed.slice(0, MAX_IMPORT_CHARS);
};

// When may spoken words send themselves? Almost never: the words wait in the message box for the person to read
// and send. Auto-send is a choice the person makes ("Send when I tap Done"), and even then a take sends on its own
// only when every rule below holds. Everything else waits.
//
// This is a hint layer, not the safety rule: every message, typed or spoken, still goes through the server's
// own checks and confirmation gates for anything that removes work.

import type { FinalInfo } from '../../hooks/useDictation';

/**
 * Words and phrases that ask to remove something. Whole words, any case. "cut" counts, but "cut to" and
 * "cut away" are comic directions and do not.
 */
const REMOVAL_PATTERN =
  /\b(?:delete|deleting|remove|removing|erase|clear|get rid of|throw (?:it |that |them )?(?:away|out)|discard|wipe|drop|scrap|trash|take (?:it |that |them )?out|undo|start over|cut(?! to\b)(?! away\b))\b/i;

/** True when a message reads as a request to remove something (English only). */
export const looksLikeRemoval = (text: string): boolean => REMOVAL_PATTERN.test(text);

/** The removal check knows English only, so other languages never auto-send. */
export const isEnglish = (lang: string | undefined): boolean => /^en(?:-|$)/i.test(lang || '');

export interface AutoSendInput {
  /** The person's stored choice ("Send when I tap Done"). Off unless they turned it on. */
  chosen: boolean;
  info: FinalInfo;
  text: string;
  lang?: string;
}

export type AutoSendVerdict = 'send' | 'wait' | 'hold-removal';

/**
 * 'send' only when the person chose it, ended the take with Done (never a pause, the limit, a hidden tab or
 * Esc), used browser dictation (the private voice model's final pass can add words that were never said), spoke
 * English, and the words do not ask to remove anything ('hold-removal' then, so the box can say why it waited).
 */
export const voiceAutoSend = ({ chosen, info, text, lang }: AutoSendInput): AutoSendVerdict => {
  if (!chosen || info.end !== 'user' || info.engine !== 'browser-cloud' || !isEnglish(lang)) return 'wait';
  if (!text.trim()) return 'wait';
  return looksLikeRemoval(text) ? 'hold-removal' : 'send';
};

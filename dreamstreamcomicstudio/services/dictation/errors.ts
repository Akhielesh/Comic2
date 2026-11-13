// Voice typing errors: every failure becomes one calm sentence and one action.
//
// The UI shows `message` and the button for `action`; `detail` (the code and the browser's own error name, plus
// a short, link-free excerpt of its text) sits behind "Show details" for anyone who needs to report it. No copy
// names a price, a model id or a stack trace, and none blames the person.

export type DictationErrorCode =
  | 'mic-blocked'
  | 'no-mic'
  | 'mic-busy'
  | 'mic-off-here'
  | 'audio-suspended'
  | 'no-speech'
  | 'siri-off'
  | 'language'
  | 'offline'
  | 'no-engine'
  | 'model-download'
  | 'transcribe'
  | 'generic';

/**
 * The one thing the person can do next: try the take again, or type. (There is no "Allow microphone": once a site
 * is blocked the browser rejects at once and asks nothing, so a button of ours cannot allow it; the message says
 * where to allow it, and "Try again" works once they have.)
 */
export type DictationErrorAction = 'retry' | 'type';

export interface DictationErrorInfo {
  code: DictationErrorCode;
  /** One calm sentence: what happened, in plain words. */
  message: string;
  /** `error` when voice typing could not work; `attention` when it worked but heard nothing usable. */
  tone: 'error' | 'attention';
  action: DictationErrorAction;
  /** Technical detail for "Show details" only: the code, the browser's error name and a short excerpt. */
  detail: string;
}

export const DICTATION_ACTION_LABEL: Record<DictationErrorAction, string> = {
  retry: 'Try again',
  type: 'Type instead'
};

export const DICTATION_ERROR_COPY: Record<DictationErrorCode, Pick<DictationErrorInfo, 'message' | 'tone' | 'action'>> = {
  'mic-blocked': { message: "To talk, allow the microphone for this site in your browser's settings, then try again.", tone: 'error', action: 'retry' },
  'no-mic': { message: 'No microphone was found on this device.', tone: 'error', action: 'retry' },
  'mic-busy': { message: 'Another app is using the microphone right now.', tone: 'error', action: 'retry' },
  'mic-off-here': { message: 'Voice typing is turned off on this page.', tone: 'error', action: 'type' },
  'audio-suspended': { message: "The microphone didn't start this time.", tone: 'error', action: 'retry' },
  'no-speech': { message: "Didn't catch anything that time.", tone: 'attention', action: 'retry' },
  'siri-off': { message: 'Browser dictation needs Siri turned on in your device settings.', tone: 'attention', action: 'type' },
  language: { message: "Your browser can't take dictation in this language.", tone: 'attention', action: 'type' },
  offline: { message: 'Browser dictation needs an internet connection.', tone: 'attention', action: 'retry' },
  'no-engine': { message: 'This browser has no built-in dictation.', tone: 'attention', action: 'type' },
  'model-download': { message: "The voice model didn't download, so your microphone stayed off.", tone: 'error', action: 'retry' },
  transcribe: { message: "Couldn't turn that into text, and nothing was sent.", tone: 'error', action: 'retry' },
  generic: { message: 'Voice typing stopped, and nothing was sent.', tone: 'error', action: 'retry' }
};

/** A failure our own code raises with a known code (the recorder's suspended audio, a missing engine). */
export class DictationError extends Error {
  readonly code: DictationErrorCode;
  constructor(code: DictationErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DictationError';
    this.code = code;
  }
}

const MAX_EXCERPT = 140;

/** The browser's error name and a short excerpt of its text, with links and long tokens removed. */
const describe = (e: unknown): string => {
  if (e == null) return '';
  if (typeof e === 'string') return excerpt(e);
  const name = typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : '';
  const text = typeof (e as { message?: unknown }).message === 'string' ? excerpt((e as { message: string }).message) : '';
  return [name, text && text !== name ? text : ''].filter(Boolean).join(': ');
};

const excerpt = (text: string): string => {
  const clean = text
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[id]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT - 1)}…` : clean;
};

/** Build the info for a code; `cause` only feeds the hidden detail. */
export const dictationError = (code: DictationErrorCode, cause?: unknown): DictationErrorInfo => {
  const what = describe(cause);
  return { code, ...DICTATION_ERROR_COPY[code], detail: what ? `${code} · ${what}` : code };
};

const MEDIA_CODES: Record<string, DictationErrorCode> = {
  NotAllowedError: 'mic-blocked',
  PermissionDeniedError: 'mic-blocked',
  NotFoundError: 'no-mic',
  DevicesNotFoundError: 'no-mic',
  OverconstrainedError: 'no-mic',
  NotReadableError: 'mic-busy',
  TrackStartError: 'mic-busy',
  AbortError: 'mic-busy',
  SecurityError: 'mic-off-here'
};

/** A failure while opening the microphone (getUserMedia, the AudioContext). */
export const fromMediaError = (e: unknown): DictationErrorInfo => {
  if (e instanceof DictationError) return dictationError(e.code, e);
  const name = typeof (e as { name?: unknown })?.name === 'string' ? (e as { name: string }).name : '';
  return dictationError(MEDIA_CODES[name] ?? 'generic', e);
};

/**
 * A SpeechRecognition `error` event's code. Null when there is nothing to show: `aborted` follows our own
 * stop or cancel. `prefixedOnly` (only `webkitSpeechRecognition` exists, as on iPhone and iPad) reads
 * `service-not-allowed` as Siri being off; elsewhere it means the browser refused the service.
 */
export const fromSpeechError = (code: unknown, opts: { prefixedOnly?: boolean } = {}): DictationErrorInfo | null => {
  const c = typeof code === 'string' ? code : '';
  const detail = { name: 'SpeechRecognitionError', message: c || 'unknown' };
  switch (c) {
    case 'aborted':
      return null;
    case 'no-speech':
      return dictationError('no-speech', detail);
    case 'audio-capture':
      return dictationError('no-mic', detail);
    case 'not-allowed':
      return dictationError('mic-blocked', detail);
    case 'service-not-allowed':
      return dictationError(opts.prefixedOnly ? 'siri-off' : 'mic-blocked', detail);
    case 'network':
      return dictationError('offline', detail);
    case 'language-not-supported':
      return dictationError('language', detail);
    default:
      return dictationError('generic', detail);
  }
};

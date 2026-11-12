// The error map: every failure reads as one calm sentence with one action, and the technical detail (kept for
// "Show details") never carries a link or a long token.
import { describe, expect, it } from 'vitest';
import { DICTATION_ACTION_LABEL, DICTATION_ERROR_COPY, DictationError, dictationError, fromMediaError, fromSpeechError } from './errors';

describe('dictation errors', () => {
  it('every message is one plain sentence with no price, link or jargon', () => {
    for (const [code, copy] of Object.entries(DICTATION_ERROR_COPY)) {
      expect(copy.message, code).toMatch(/^[A-Z][^.!?]*[.]$/);
      expect(copy.message, code).not.toMatch(/[$¢]|https?:|error|exception|whisper|onnx|webgpu|wasm/i);
      expect(Object.keys(DICTATION_ACTION_LABEL), code).toContain(copy.action);
    }
    expect(Object.values(DICTATION_ACTION_LABEL)).toEqual(['Try again', 'Allow microphone', 'Type instead']);
  });

  it('maps each getUserMedia failure by its DOMException name', () => {
    const name = (n: string) => fromMediaError(new DOMException('x', n)).code;
    expect(name('NotAllowedError')).toBe('mic-blocked');
    expect(name('NotFoundError')).toBe('no-mic');
    expect(name('OverconstrainedError')).toBe('no-mic');
    expect(name('NotReadableError')).toBe('mic-busy');
    expect(name('AbortError')).toBe('mic-busy');
    expect(name('SecurityError')).toBe('mic-off-here');
    expect(name('SomethingElse')).toBe('generic');
    expect(fromMediaError(new DictationError('audio-suspended')).code).toBe('audio-suspended');
    expect(fromMediaError(new DOMException('x', 'NotAllowedError')).action).toBe('allow-mic');
  });

  it('maps SpeechRecognition codes; our own abort shows nothing; service-not-allowed is Siri only on prefixed-only browsers', () => {
    expect(fromSpeechError('aborted')).toBeNull();
    expect(fromSpeechError('no-speech')?.code).toBe('no-speech');
    expect(fromSpeechError('audio-capture')?.code).toBe('no-mic');
    expect(fromSpeechError('not-allowed')?.code).toBe('mic-blocked');
    expect(fromSpeechError('network')?.code).toBe('offline');
    expect(fromSpeechError('language-not-supported')?.code).toBe('language');
    expect(fromSpeechError('service-not-allowed')?.code).toBe('mic-blocked');
    expect(fromSpeechError('service-not-allowed', { prefixedOnly: true })?.code).toBe('siri-off');
    expect(fromSpeechError('bad-grammar')?.code).toBe('generic');
  });

  it('the hidden detail names the code and the cause, without links or long ids', () => {
    const info = dictationError('model-download', new Error(`Could not fetch https://huggingface.co/x/config.json ${'a'.repeat(40)}`));
    expect(info.detail).toBe('model-download · Error: Could not fetch [link] [id]');
    expect(dictationError('generic').detail).toBe('generic');
    expect(dictationError('generic', new Error('y'.repeat(400))).detail.length).toBeLessThan(170);
  });
});

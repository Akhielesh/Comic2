// The alert chime's one audio context (notify SPEC §5.6). Browsers only let a page make sound after the person has
// pressed something, so the context is made only inside a gesture: while the sound is on, one capture-phase, passive
// pointerdown/keydown listener waits for the first press, makes the context there, resumes it inside that gesture and
// suspends it again, and goes away. Before that press, and while the sound is off, no context exists. The context runs
// only while a chime plays (chime.ts resumes it and suspends it when the last note ends), so it costs nothing between
// chimes; it is closed on sign-out. Where the browser has an audio session (Safari 16.4+) it is "ambient" only while a
// chime plays, so the chime mixes with the person's music and obeys the iPhone's silent switch, and it goes back to
// "auto" when the last chime ends: the session is page-wide, and dictation or a call needs it free. A session someone
// else set (a call or a recording sets "play-and-record") is never touched. Reduced motion does not mute the chime (it
// is the cue, not motion). Every call is guarded: a browser without Web Audio, or one that refuses it, stays silent.

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let disarm: (() => void) | null = null;
/** Chimes scheduled and not ended (the context stays running until the last one ends). */
let playing = 0;
/** This module set the audio session to "ambient" for the chimes playing now (and gives it back when they end). */
let holdsSession = false;

const audioSession = (): { type: string } | undefined => {
  try {
    return typeof navigator !== 'undefined' ? (navigator as unknown as { audioSession?: { type: string } }).audioSession : undefined;
  } catch {
    return undefined;
  }
};

/** A chime starts: "ambient" while it plays, but only over the default session (never over a call's or a recording's). */
const holdAmbientSession = () => {
  if (holdsSession) return;
  try {
    const session = audioSession();
    if (!session || session.type !== 'auto') return;
    session.type = 'ambient';
    holdsSession = session.type === 'ambient';
  } catch {
    /* an audio session that refuses the type: the default session plays the chime too */
  }
};

/** The last chime ended: back to "auto", unless someone else took the session meanwhile. */
const releaseAmbientSession = () => {
  if (!holdsSession) return;
  holdsSession = false;
  try {
    const session = audioSession();
    if (session && session.type === 'ambient') session.type = 'auto';
  } catch {
    /* nothing to give back */
  }
};

const ctorOf = (): AudioContextCtor | null => {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return w.AudioContext || w.webkitAudioContext || null;
  } catch {
    return null;
  }
};

const quietly = (run: () => Promise<unknown> | unknown): void => {
  try {
    const out = run();
    if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(() => undefined);
  } catch {
    /* audio is optional */
  }
};

const suspendIfIdle = () => {
  if (ctx && playing === 0 && ctx.state === 'running') quietly(() => ctx!.suspend());
};

/**
 * Call inside a person's gesture (a press, a key, the Play button): makes the context if there is none, resumes it
 * there (which is what unlocks audio) and suspends it again once that settles, unless a chime has started meanwhile.
 */
export function unlockAudio(): AudioContext | null {
  if (!ctx || ctx.state === 'closed') {
    const Ctor = ctorOf();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
      return null;
    }
  }
  const made = ctx;
  try {
    const resumed = made.resume();
    void Promise.resolve(resumed)
      .then(() => {
        if (made === ctx) suspendIfIdle();
      })
      .catch(() => undefined);
  } catch {
    /* resume refused outside a gesture the browser recognises: the next press tries again */
  }
  return made;
}

/** Waits for the first press or key, unlocks there, then stops listening. Returns the disarm. */
export function armAudioUnlock(): () => void {
  if (disarm) return disarm;
  if (typeof window === 'undefined') return () => undefined;
  const options: AddEventListenerOptions = { capture: true, passive: true };
  const onGesture = () => {
    stop();
    unlockAudio();
  };
  const stop = () => {
    window.removeEventListener('pointerdown', onGesture, options);
    window.removeEventListener('keydown', onGesture, options);
    if (disarm === stop) disarm = null;
  };
  window.addEventListener('pointerdown', onGesture, options);
  window.addEventListener('keydown', onGesture, options);
  disarm = stop;
  return stop;
}

/** The context, once a gesture made it (null before, while the sound is off and after sign-out). */
export const audioContext = (): AudioContext | null => (ctx && ctx.state !== 'closed' ? ctx : null);

/** Sound on: wait for the next press if there is no context yet. Sound off: no listener and no context. */
export function syncAudioToSound(on: boolean): void {
  if (on) {
    if (!audioContext()) armAudioUnlock();
    return;
  }
  disarm?.();
  closeAudio();
}

/** Sign-out (or sound off): stop listening and close the context. */
export function closeAudio(): void {
  disarm?.();
  const closing = ctx;
  ctx = null;
  playing = 0;
  releaseAmbientSession();
  if (closing && closing.state !== 'closed') quietly(() => closing.close());
}

/** chime.ts: a chime is about to play, before the context resumes (keeps it running; the session is ambient). */
export const beginPlay = (): void => {
  playing += 1;
  holdAmbientSession();
};

/** chime.ts: a chime ended (the context is suspended and the session given back once none is left). */
export const endPlay = (): void => {
  playing = Math.max(0, playing - 1);
  if (playing === 0) releaseAmbientSession();
  suspendIfIdle();
};

/** Test seam. */
export function __resetAudioForTests(): void {
  disarm?.();
  disarm = null;
  ctx = null;
  playing = 0;
  holdsSession = false;
}

import React, { useEffect, useRef, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';

// SpeechSynthesis has one queue per window. Switching replies stops the prior one.
let stopActive: (() => void) | null = null;

export function ReadReplyAloud({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState('');
  const owns = useRef<(() => void) | null>(null);
  const supported = typeof window !== 'undefined' && typeof window.speechSynthesis?.getVoices === 'function'
    && typeof window.SpeechSynthesisUtterance === 'function';

  useEffect(() => {
    if (supported) window.speechSynthesis.getVoices();
    return () => { owns.current?.(); };
  }, [supported, text]);

  if (!supported || !text.trim()) return null;

  const toggle = () => {
    if (playing) { owns.current?.(); return; }
    const synth = window.speechSynthesis;
    const local = synth.getVoices().filter(voice => voice.localService);
    const lang = document.documentElement.lang || navigator.language;
    const voice = local.find(item => item.lang === lang) || local.find(item => item.lang.split('-')[0] === lang.split('-')[0])
      || local.find(item => item.default) || local[0];
    if (!voice) { setNotice('Install a voice on this device to listen to replies.'); return; }
    stopActive?.();
    const spoken = new SpeechSynthesisUtterance(text);
    spoken.voice = voice;
    spoken.lang = voice.lang;
    const finish = () => {
      if (owns.current !== stop) return;
      owns.current = null;
      if (stopActive === stop) stopActive = null;
      setPlaying(false);
    };
    const stop = () => {
      finish();
      synth.cancel();
    };
    owns.current = stop;
    stopActive = stop;
    spoken.onend = finish;
    spoken.onerror = finish;
    setNotice('');
    setPlaying(true);
    try { synth.speak(spoken); } catch { finish(); setNotice('Your device could not play this reply.'); }
  };

  return <>
    <button type="button" onClick={toggle} aria-pressed={playing} aria-label={playing ? 'Stop reading reply' : 'Read reply aloud'}
      className="tap-target flex items-center gap-1 font-bold hover:text-[var(--ds-ink)]">
      {playing ? <Square className="h-3 w-3" aria-hidden /> : <Volume2 className="h-3 w-3" aria-hidden />}
      {playing ? 'Stop' : 'Listen'}
    </button>
    {notice && <span role="status">{notice}</span>}
  </>;
}

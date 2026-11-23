import React, { useEffect, useId, useRef, useState } from 'react';
import { USERNAME_HINT, USERNAME_REGEX, type UsernameAvailability } from '../shared/username';
import { checkUsername } from '../services/usernames';
import { Field } from './ds/Field';
import { Input } from './ds/Input';
import { Button } from './ds/Button';

export function SignupUsername({ value, onChange, taken, onSignIn }: {
  value: string; onChange: (value: string) => void; taken?: string; onSignIn: () => void;
}) {
  const name = value.trim();
  const statusId = useId();
  const [checked, setChecked] = useState<{ name: string; result: UsernameAvailability | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!USERNAME_REGEX.test(name)) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void checkUsername(name, abort.signal)
        .then(result => { if (!abort.signal.aborted) setChecked({ name, result }); })
        .catch(() => { if (!abort.signal.aborted) setChecked({ name, result: null }); });
    }, 450);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [name, taken]);
  const result = checked?.name === name ? checked.result : undefined;
  const inUse = (Boolean(taken) && taken.toLowerCase() === name.toLowerCase()) || result?.available === false;
  useEffect(() => {
    input.current?.setCustomValidity(inUse ? 'Choose another username or sign in to your account.' : '');
  }, [inUse]);
  const status = inUse ? 'That username is taken.' : result?.available ? 'That username is available.' : result === null ? 'We’ll check this username when you create your account.' : '';
  return <div>
    <Field label="Username" required description={USERNAME_HINT}>
      <Input ref={input} type="text" required autoComplete="username" autoCapitalize="none" spellCheck={false}
        maxLength={20} placeholder="Super_hero" value={value} aria-invalid={inUse || undefined} aria-describedby={statusId}
        onChange={event => onChange(event.target.value)} />
    </Field>
    <div id={statusId} aria-live="polite" className="mt-1 text-sm text-[var(--ds-muted)]">{status}</div>
    {inUse && <div className="mt-2 flex flex-wrap items-center gap-2">
      {result?.suggestions.map(suggestion => <Button key={suggestion} type="button" size="sm" variant="outline"
        aria-label={'Use ' + suggestion} onClick={() => { onChange(suggestion); input.current?.focus(); }}>{suggestion}</Button>)}
      <Button type="button" size="sm" variant="link" onClick={onSignIn}>Sign in to my account</Button>
    </div>}
  </div>;
}

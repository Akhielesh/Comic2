import { WRAP_TEXT } from './chat/studioDesign';
import React, { useState } from 'react';
import { Button } from './ds/Button';
import { Checkbox } from './ds/Checkbox';
import { Field } from './ds/Field';
import { Input } from './ds/Input';
import type { GoogleProfile } from '../services/googleSignIn';

export function GoogleAccountProfile({ email, firstName, maxDob, busy, onSubmit, onCancel }: {
  email: string; firstName: string; maxDob: string; busy: boolean;
  onSubmit: (profile: GoogleProfile) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(firstName);
  const [username, setUsername] = useState('');
  const [dob, setDob] = useState('');
  const [terms, setTerms] = useState(false);
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    if (!busy && terms) onSubmit({ firstName: name.trim(), username: username.trim(), dob, acceptedTerms: terms });
  }}>
    <p className={`${WRAP_TEXT} text-[var(--ds-muted)]`}>Google verified {email}. Complete your profile to open the studio.</p>
    <Field label="First name" required><Input required autoComplete="given-name" maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
    <Field label="Username" description="Use 3–20 letters, numbers or underscores." required><Input required autoComplete="username" pattern="[A-Za-z0-9_]{3,20}" maxLength={20} value={username} onChange={e => setUsername(e.target.value)} /></Field>
    <Field label="Date of birth" description="You must be at least 8 years old." required><Input required type="date" autoComplete="bday" max={maxDob} value={dob} onChange={e => setDob(e.target.value)} /></Field>
    <Checkbox checked={terms} onCheckedChange={setTerms} label={<span>I accept the <a className="underline" target="_blank" rel="noopener" href="/?view=terms">Terms and Conditions</a> and <a className="underline" target="_blank" rel="noopener" href="/?view=privacy">Privacy Policy</a>.</span>} />
    <Button type="submit" disabled={!terms} loading={busy} className="w-full">Create account</Button>
    <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>Use another sign-in method</Button>
  </form>;
}

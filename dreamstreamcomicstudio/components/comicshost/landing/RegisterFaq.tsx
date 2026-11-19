// The end of the landing: "Register your interest" (the app's own WaitlistForm, rendered as it is: its fields, its
// questions and what it says after a visitor sends it belong to that form) and the questions, each a native
// <details> that opens without script. Members see their way back to their comics instead of the form. Ink only.
import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { DENSITY, FOCUS_RING, FONT_DISPLAY } from '../../chat/studioDesign';
import { Button } from '../../ds/Button';
import { CONTACT_HREF } from '../../layout/LegalMicroLinks';
import { SUPPORT_EMAIL } from '../../legal/contacts';
import { WaitlistForm } from '../../WaitlistForm';
import { FAQ, FAQ_HEAD, JOIN, REGISTER, fill } from './landingCopy';
import { LANDING_VALUES } from './landingModels';
import { showSection } from './parts';

/** A quiet text link: ink, the underline draws in, 44 px under a coarse pointer. */
export const QUIET_LINK = cn('ds-link inline-flex items-center font-medium text-[var(--ds-ink)]', DENSITY.coarse, FOCUS_RING);

export const RegisterSection: React.FC<{ signedIn: boolean; onSignIn: () => void; onOpenComics: () => void }> = ({ signedIn, onSignIn, onOpenComics }) => (
  <section id="register" aria-labelledby="landing-register" className="landing-section">
    <div className="landing-register">
      <h2 id="landing-register" tabIndex={-1} className={cn('landing-title focus:outline-none', FONT_DISPLAY)}>
        {signedIn ? REGISTER.signedInTitle : REGISTER.title}
      </h2>
      <p className="landing-lead">{signedIn ? REGISTER.signedInLine : REGISTER.line}</p>
      {signedIn ? (
        <Button variant="outline" size="lg" className="landing-register-action" onClick={onOpenComics}>
          {REGISTER.openComics}
        </Button>
      ) : (
        <>
          <WaitlistForm kind="access" source="landing" buttonLabel={JOIN.short} onSignIn={onSignIn} className="landing-register-form" />
          <p className="landing-member">
            {REGISTER.memberAsk}
            <button type="button" className={QUIET_LINK} onClick={onSignIn}>
              {REGISTER.signIn}
            </button>
          </p>
        </>
      )}
    </div>
  </section>
);

/** One question: a native <details> (it opens without script); its summary also states aria-expanded. */
const FaqItem: React.FC<{ question: string; children: React.ReactNode }> = ({ question, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <details className="ds-disclosure landing-faq-item" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary aria-expanded={open} className={cn('landing-faq-q', DENSITY.coarse, FOCUS_RING)}>
        <span>{question}</span>
        <ChevronDown aria-hidden className="landing-faq-chevron" />
      </summary>
      <div className="landing-faq-a">{children}</div>
    </details>
  );
};

export const FaqSection: React.FC = () => (
  <section id="faq" aria-labelledby="landing-faq" className="landing-section">
    <div className="landing-head">
      <h2 id="landing-faq" tabIndex={-1} className={cn('landing-title focus:outline-none', FONT_DISPLAY)}>
        {FAQ_HEAD.title}
      </h2>
    </div>
    <div className="landing-faq">
      {FAQ.map((item, i) => (
        <FaqItem key={item.q} question={item.q}>
          {i === FAQ.length - 1 ? (
            <p>
              {item.a}{' '}
              <a href={CONTACT_HREF} className={QUIET_LINK}>
                {SUPPORT_EMAIL}
              </a>
            </p>
          ) : (
            <p>{fill(item.a, LANDING_VALUES)}</p>
          )}
          {item.q.startsWith('Does it cost') ? (
            <button type="button" className={QUIET_LINK} onClick={() => showSection('pricing')}>
              {FAQ_HEAD.seePricing}
            </button>
          ) : null}
          {item.q.startsWith('Which models') ? (
            <button type="button" className={QUIET_LINK} onClick={() => showSection('models')}>
              {FAQ_HEAD.seeModels}
            </button>
          ) : null}
        </FaqItem>
      ))}
    </div>
  </section>
);

/**
 * The home page's "Register interest" section: why and how in the left column, the form on a card in the
 * right one, inside the page's one 28 px hero panel. The section and its words are eager; the form (the
 * ds primitives and the optional bot check) is a lazy chunk, requested when the page is idle or the section
 * nears the viewport, at once when the visitor arrives from a confirmation link (?newsletter=…), and
 * the card holds the form's shape meanwhile so nothing moves when it arrives.
 */
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { readNewsletterLanding } from '../../services/interest';
import { ACCESS_NOTE, CONTACT_EMAIL } from './content';
import { COPY, FEATURE_CARD, LEAD, PAGE_COLUMN, SCROLL_TARGET, SECTION_H2, TEXT_LINK } from './landingStyles';
import { QuietBoundary } from './QuietBoundary';
import { useNearViewport } from './useNearViewport';

const loadForm = () => import('./RegisterInterestForm');
export const preloadRegisterInterest = (): void => {
  loadForm().catch(() => undefined);
};
const LazyForm = React.lazy(() => loadForm().then((m) => ({ default: m.RegisterInterestForm })));

/** The form's shape while its chunk loads: the same rows, still (no shimmer loop running off screen). */
function FormPlaceholder() {
  return (
    <div className="flex flex-col gap-5">
      <span className="sr-only">Loading the form…</span>
      <span aria-hidden="true" className="bg-ds-skeleton block h-5 w-2/3 rounded-[var(--ds-radius-sm)]" />
      <span aria-hidden="true" className="grid gap-2 medium:grid-cols-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="bg-ds-skeleton block h-[66px] rounded-[var(--ds-radius-panel)]" />
        ))}
      </span>
      <span aria-hidden="true" className="bg-ds-skeleton block h-10 rounded-[var(--ds-radius-control)]" />
      <span aria-hidden="true" className="bg-ds-skeleton block h-11 w-48 rounded-full" />
    </div>
  );
}

function FormFailed() {
  return (
    <p role="status" className={COPY}>
      The form didn’t load. Reload the page, or email{' '}
      <a href={`mailto:${CONTACT_EMAIL}`} className={TEXT_LINK}>
        {CONTACT_EMAIL}
      </a>{' '}
      and we’ll add you by hand.
    </p>
  );
}

export interface RegisterInterestSectionProps {
  /** Opens the sign-in page's "Request access" (shown only when given, and only to signed-out visitors). */
  onRequestAccess?: () => void;
  signedIn: boolean;
}

export function RegisterInterestSection({ onRequestAccess, signedIn }: RegisterInterestSectionProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(cardRef, '480px 0px');
  // A confirm / unsubscribe link lands here: show its message without waiting for a scroll.
  const [arrived] = useState(() => readNewsletterLanding() !== null);
  const show = near || arrived;

  useEffect(() => {
    if (arrived) preloadRegisterInterest();
  }, [arrived]);

  return (
    <section id="register-interest" aria-labelledby="register-interest-title" className={`${SCROLL_TARGET} py-16 sm:py-24`}>
      <div className={PAGE_COLUMN}>
        <div className="ds-reveal grid gap-10 rounded-[var(--ds-radius-hero)] border border-ds-hairline bg-ds-well p-5 medium:p-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14 lg:p-14">
          <div className="min-w-0">
            <p className="ds-overline-display">Register interest</p>
            <h2 id="register-interest-title" data-jump-target className={`mt-4 focus:outline-none ${SECTION_H2}`}>
              Hear first about the studios you want.
            </h2>
            <p className={`mt-4 ${LEAD}`}>
              Pick the studios you care about and we’ll send occasional updates about them, nothing else.
            </p>
            <ul className="mt-6 flex flex-col gap-3">
              {[
                'One email to confirm your address. Nothing more until you do.',
                'Only the studios you pick, and a one-click unsubscribe in every email.',
                'We never sell your address.'
              ].map((point) => (
                <li key={point} className={`flex gap-3 ${COPY}`}>
                  <span aria-hidden="true" className="mt-[11px] size-1.5 shrink-0 rounded-full bg-ds-ink" />
                  <span className="min-w-0">{point}</span>
                </li>
              ))}
            </ul>
            {!signedIn ? (
              <p className={`mt-6 ${COPY}`}>
                {ACCESS_NOTE}{' '}
                {onRequestAccess ? (
                  <>
                    Need an account?{' '}
                    <button type="button" onClick={onRequestAccess} className={TEXT_LINK}>
                      Request access
                    </button>
                  </>
                ) : (
                  'If someone sent you an invite link, open it to create your account.'
                )}
              </p>
            ) : null}
          </div>

          {/* id="stay-updated": the header's "get updates" jump (App.tsx goToStayUpdated) lands on the form. */}
          <div id="stay-updated" ref={cardRef} className={`min-w-0 self-start p-5 medium:p-6 ${SCROLL_TARGET} ${FEATURE_CARD} shadow-[shadow:var(--ds-shadow-soft)]`}>
            {show ? (
              <QuietBoundary fallback={<FormFailed />}>
                <Suspense fallback={<FormPlaceholder />}>
                  <LazyForm source="home-register-interest" />
                </Suspense>
              </QuietBoundary>
            ) : (
              <FormPlaceholder />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

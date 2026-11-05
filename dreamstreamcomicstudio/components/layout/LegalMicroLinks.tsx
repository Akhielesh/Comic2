import React from 'react';
import { SUPPORT_EMAIL } from '../legal/legalFacts';
import { LEGAL_DOCS, pushLegalPath, type LegalDocId } from '../legal/legalRoutes';

interface LegalMicroLinksProps {
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
  /** Opens any other legal document in the app; without it the links load their page. */
  onOpenLegal?: (doc: LegalDocId) => void;
  className?: string;
}

const LINK = 'hover:text-black transition-colors';

// Every legal document has a real address (/privacy, /terms, …): a plain click opens it inside the
// app (with its own history entry, so Back returns here), and a middle-click, a copied link or a new
// tab still lands on the right page.
export const LegalMicroLinks: React.FC<LegalMicroLinksProps> = ({
  onOpenPrivacy,
  onOpenTerms,
  onOpenFaq,
  onOpenLegal,
  className = ''
}) => {
  const openIn = (doc: LegalDocId): (() => void) | undefined =>
    doc === 'privacy' ? onOpenPrivacy : doc === 'terms' ? onOpenTerms : onOpenLegal ? () => onOpenLegal(doc) : undefined;

  return (
    <div className={`border-t border-slate-200 bg-white/80 ${className}`}>
      <div className="max-w-7xl mx-auto px-6 py-3 text-[11px] font-bold text-slate-500 flex flex-wrap items-center gap-4">
        {LEGAL_DOCS.map((doc) => {
          const open = openIn(doc.id);
          return (
            <a
              key={doc.id}
              href={doc.path}
              className={LINK}
              onClick={(e) => {
                if (!open || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                pushLegalPath(doc.id);
                open();
              }}
            >
              {doc.label}
            </a>
          );
        })}
        <button type="button" onClick={onOpenFaq} className={LINK}>
          FAQs
        </button>
        <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
          Contact
        </a>
      </div>
    </div>
  );
};

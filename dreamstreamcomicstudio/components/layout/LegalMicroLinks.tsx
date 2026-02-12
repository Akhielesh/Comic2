import React from 'react';

interface LegalMicroLinksProps {
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onOpenFaq: () => void;
  className?: string;
}

export const LegalMicroLinks: React.FC<LegalMicroLinksProps> = ({
  onOpenPrivacy,
  onOpenTerms,
  onOpenFaq,
  className = ''
}) => {
  return (
    <div className={`border-t border-slate-200 bg-white/80 ${className}`}>
      <div className="max-w-7xl mx-auto px-6 py-3 text-[11px] font-bold text-slate-500 flex flex-wrap items-center gap-4">
        <button type="button" onClick={onOpenPrivacy} className="hover:text-black transition-colors">
          Privacy Policy
        </button>
        <button type="button" onClick={onOpenTerms} className="hover:text-black transition-colors">
          Terms &amp; Conditions
        </button>
        <button type="button" onClick={onOpenFaq} className="hover:text-black transition-colors">
          FAQs
        </button>
        <a href="mailto:contact@dreamstream.com" className="hover:text-black transition-colors">
          Contact
        </a>
      </div>
    </div>
  );
};

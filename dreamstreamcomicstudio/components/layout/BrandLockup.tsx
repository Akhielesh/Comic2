import React from 'react';

interface BrandLockupProps {
  onClick?: () => void;
  clickable?: boolean;
  className?: string;
}

export const BrandLockup: React.FC<BrandLockupProps> = ({ onClick, clickable = true, className = '' }) => {
  const content = (
    <>
      <div className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-xl flex items-center justify-center text-black font-display text-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,0.8)] transform -rotate-2 shrink-0">
        D
      </div>
      <div className="leading-none">
        <div className="font-display text-xl text-slate-900">DreamStream</div>
        <div className="text-[10px] font-bold text-brand-blue uppercase tracking-widest mt-0.5">Comic Studio</div>
      </div>
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-3 hover:opacity-80 transition-opacity ${className}`}
      >
        {content}
      </button>
    );
  }

  return <div className={`flex items-center gap-3 ${className}`}>{content}</div>;
};

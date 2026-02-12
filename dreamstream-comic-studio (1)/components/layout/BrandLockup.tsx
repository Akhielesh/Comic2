import React from 'react';

interface BrandLockupProps {
  onClick?: () => void;
  clickable?: boolean;
  className?: string;
}

export const BrandLockup: React.FC<BrandLockupProps> = ({ onClick, clickable = true, className = '' }) => {
  const content = (
    <>
      <div className="w-10 h-10 bg-brand-yellow border-2 border-black rounded-lg flex items-center justify-center text-black font-display text-2xl shadow-comic transform -rotate-3">
        D
      </div>
      <div className="flex flex-col">
        <span className="font-display text-2xl tracking-tight text-black leading-none">DreamStream</span>
        <span className="font-comic font-bold text-brand-blue text-xs leading-none">Comic Studio</span>
      </div>
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-3 cursor-pointer ${className}`}
      >
        {content}
      </button>
    );
  }

  return <div className={`flex items-center gap-3 ${className}`}>{content}</div>;
};

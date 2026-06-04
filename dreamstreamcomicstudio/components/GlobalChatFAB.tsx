import React, { useState } from 'react';
import { MessageSquare } from 'lucide-react';

interface GlobalChatFABProps {
  isAuthenticated: boolean;
  onOpenChat: () => void;
  onSignIn: () => void;
}

export const GlobalChatFAB: React.FC<GlobalChatFABProps> = ({
  isAuthenticated,
  onOpenChat,
  onSignIn,
}) => {
  const [hovered, setHovered] = useState(false);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {hovered && (
        <div className="bg-black text-white text-xs font-bold px-3 py-2 rounded-xl border-2 border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] whitespace-nowrap animate-fade-in">
          {isAuthenticated ? 'Open AI Chat' : 'Sign in to use AI Chat'}
        </div>
      )}
      <button
        type="button"
        onClick={isAuthenticated ? onOpenChat : onSignIn}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="w-14 h-14 bg-brand-blue text-white border-4 border-black rounded-full shadow-[4px_4px_0px_0px_rgba(0,0,0,0.8)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all duration-150 flex items-center justify-center"
        aria-label={isAuthenticated ? 'Open AI Chat' : 'Sign in to use AI Chat'}
      >
        <MessageSquare className="w-6 h-6" />
      </button>
    </div>
  );
};

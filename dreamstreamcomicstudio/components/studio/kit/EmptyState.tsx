// EmptyState (Sprint 2, S2.5): a centered illustration + title + description + optional action.
// Used for the Code Studio start screen, build errors, and other "nothing here yet" moments.

import React from 'react';
import { Reveal } from './Reveal';
import { useStudioTheme } from './themeStore';

export interface EmptyStateProps {
  /** Inline SVG illustration (themed via currentColor by the parent tone). */
  art?: React.ReactNode;
  title: string;
  description?: string;
  /** Action(s) — e.g. a primary button. */
  children?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ art, title, description, children, className }) => {
  const t = useStudioTheme();
  return (
    <Reveal className={`flex flex-col items-center justify-center text-center p-10 ${className ?? ''}`}>
      {art && <div className={`mb-4 ${t.textFaint}`}>{art}</div>}
      <p className={`text-sm font-bold ${t.textDim}`}>{title}</p>
      {description && <p className={`mt-1 text-sm ${t.textFaint} max-w-sm`}>{description}</p>}
      {children && <div className="mt-5">{children}</div>}
    </Reveal>
  );
};

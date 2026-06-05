// DiffView (Sprint 3): renders an LCS line diff with +/- gutters and theme-aware colours.

import React, { useMemo } from 'react';
import { diffLines } from './diff';
import { useStudioTheme } from '../kit';

export interface DiffViewProps {
  oldText: string;
  newText: string;
}

export const DiffView: React.FC<DiffViewProps> = ({ oldText, newText }) => {
  const t = useStudioTheme();
  const ops = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  return (
    <div className={`overflow-auto rounded-md border ${t.edge} ${t.editorBg} max-h-64`}>
      <pre className="text-[11px] leading-relaxed font-mono">
        {ops.map((op, i) => {
          const sign = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
          const cls =
            op.type === 'add' ? 'bg-emerald-500/10 text-emerald-600'
            : op.type === 'del' ? 'bg-rose-500/10 text-rose-600'
            : t.textDim;
          return (
            <div key={i} className={`flex ${cls}`}>
              <span className={`w-4 shrink-0 select-none text-center ${t.textFaint}`}>{sign}</span>
              <span className="whitespace-pre-wrap break-words pr-2">{op.text || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
};

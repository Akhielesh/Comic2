import React from 'react';

interface AgentStageShellProps {
  eyebrow: string;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  minHeightClassName?: string;
}

export const AgentStageShell: React.FC<AgentStageShellProps> = ({
  eyebrow,
  title,
  description,
  icon,
  actions,
  sidebar,
  children,
  minHeightClassName = 'min-h-[680px]'
}) => {
  return (
    <div className="mx-auto w-full max-w-7xl animate-fade-in">
      <div className="overflow-hidden rounded-xl border-4 border-black bg-white text-black shadow-comic">
        <div className="flex flex-col gap-4 border-b-4 border-black bg-white px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {icon && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-2 border-black bg-brand-yellow text-black shadow-comic">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wide text-brand-blue">{eyebrow}</div>
              <h2 className="break-words text-2xl font-display text-black">{title}</h2>
              {description && <p className="mt-1 max-w-2xl text-sm leading-6 font-comic text-slate-600">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>

        {sidebar ? (
          <div className={`grid grid-cols-1 lg:grid-cols-[360px_1fr] ${minHeightClassName}`}>
            <aside className="border-b-4 border-black bg-amber-50 px-5 py-5 lg:border-b-0 lg:border-r-4">
              {sidebar}
            </aside>
            <section className="min-w-0 bg-white">{children}</section>
          </div>
        ) : (
          <section className={`${minHeightClassName} min-w-0 bg-white`}>{children}</section>
        )}
      </div>
    </div>
  );
};

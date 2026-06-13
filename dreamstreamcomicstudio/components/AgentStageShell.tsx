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
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#050505] text-zinc-100 shadow-2xl">
        <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {icon && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-950">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase text-zinc-500">{eyebrow}</div>
              <h2 className="break-words text-xl font-semibold text-zinc-100">{title}</h2>
              {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-500">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>

        {sidebar ? (
          <div className={`grid grid-cols-1 lg:grid-cols-[360px_1fr] ${minHeightClassName}`}>
            <aside className="border-b border-zinc-800 bg-[#111111] px-5 py-5 lg:border-b-0 lg:border-r">
              {sidebar}
            </aside>
            <section className="min-w-0">{children}</section>
          </div>
        ) : (
          <section className={`${minHeightClassName} min-w-0`}>{children}</section>
        )}
      </div>
    </div>
  );
};

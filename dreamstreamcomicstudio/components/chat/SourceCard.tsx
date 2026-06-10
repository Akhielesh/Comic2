import React from 'react';
import { ExternalLink } from 'lucide-react';

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const faviconOf = (url: string): string => {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return '';
  }
};

interface SourceCardProps {
  index: number;
  url: string;
  title?: string;
}

// A compact source chip — favicon + title + domain, in the calm-studio language.
// Deliberately NO hover preview/unfurl: the popup thumbnails were cumbersome and
// fired a network request per link on hover. A source list should be a quiet
// reference, not a hover game.
export const SourceCard: React.FC<SourceCardProps> = ({ index, url, title }) => {
  const domain = domainOf(url);
  const favicon = faviconOf(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title || url}
      className="group flex items-center gap-2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2 py-1 transition-colors duration-200 hover:bg-[var(--ds-well)]"
    >
      <span className="w-3.5 shrink-0 text-[10px] font-semibold text-[var(--ds-muted)]">{index}</span>
      {favicon && <img src={favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded ring-1 ring-[var(--ds-hairline-soft)]" loading="lazy" />}
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--ds-ink)]">{title || domain}</span>
      <span className="hidden shrink-0 text-[10px] text-[var(--ds-muted)] sm:inline">{domain}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-black/20 transition-colors duration-200 group-hover:text-[var(--ds-muted)]" />
    </a>
  );
};

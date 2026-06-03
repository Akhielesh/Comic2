import React from 'react';
import { Newspaper, ExternalLink } from 'lucide-react';
import type { NewsResultsArtifact } from '../../../apiTypes';

// Human "x minutes/hours/days ago" from an ISO timestamp.
const timeAgo = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const diff = Date.now() - t;
  if (diff < 0) return undefined;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
};

const heading = (data: NewsResultsArtifact): string => {
  if (data.query) return `News: “${data.query}”`;
  if (data.topic) return `${data.topic.charAt(0).toUpperCase()}${data.topic.slice(1)} headlines`;
  return 'Top headlines';
};

// Sourced, dated news headlines from real outlets (Google News). Each item links
// out to the article; the card keeps the chat readable while surfacing recency.
export const NewsCard: React.FC<{ data: NewsResultsArtifact }> = ({ data }) => {
  if (!data?.items?.length) return null;
  return (
    <div className="my-2 border-2 border-black rounded-lg bg-white shadow-comic overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b-2 border-black bg-amber-50">
        <Newspaper className="w-4 h-4" />
        <span className="text-[12px] font-extrabold uppercase tracking-wide">{heading(data)}</span>
      </div>
      <ul className="divide-y divide-slate-200">
        {data.items.map((n, i) => {
          const ago = timeAgo(n.publishedAt);
          return (
            <li key={`${n.url}-${i}`}>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex gap-2 px-3 py-2 hover:bg-amber-50/70 transition-colors"
              >
                <span className="text-[11px] font-bold text-slate-400 w-4 shrink-0 pt-0.5">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold leading-snug group-hover:underline">
                    {n.title}
                    <ExternalLink className="inline w-3 h-3 ml-1 align-[-1px] opacity-0 group-hover:opacity-60" />
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5 truncate">
                    {[n.source, ago].filter(Boolean).join(' · ')}
                  </span>
                  {n.snippet && (
                    <span className="block text-[11px] text-slate-600 mt-0.5 line-clamp-2">{n.snippet}</span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

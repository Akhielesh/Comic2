import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { unfurlLink, type UnfurlResult } from '../../services/chatApi';

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

/** A compact web source row with favicon + domain, and a hover preview card. */
export const SourceCard: React.FC<SourceCardProps> = ({ index, url, title }) => {
  const domain = domainOf(url);
  const favicon = faviconOf(url);
  const [meta, setMeta] = useState<UnfurlResult | null>(null);

  // Fetch the rich preview on first hover.
  const loadPreview = () => {
    if (meta) return;
    void unfurlLink(url).then(setMeta);
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={loadPreview}
      onFocus={loadPreview}
      className="group relative flex items-start gap-2 border-2 border-black rounded-lg px-2.5 py-1.5 bg-white hover:bg-slate-50"
    >
      <span className="text-[10px] font-bold text-slate-400 mt-0.5 shrink-0">{index}</span>
      {favicon && <img src={favicon} alt="" className="w-4 h-4 rounded mt-0.5 shrink-0" loading="lazy" />}
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-blue-700 truncate">{title || domain}</span>
        <span className="block text-[10px] text-slate-400 truncate">{domain}</span>
      </span>
      <ExternalLink className="w-3 h-3 text-slate-400 shrink-0 mt-0.5" />

      {/* Hover preview (rich once unfurled) */}
      <span className="pointer-events-none absolute left-0 bottom-full mb-1.5 z-40 hidden group-hover:block w-72 bg-white border-2 border-black rounded-lg shadow-comic overflow-hidden normal-case font-normal">
        {meta?.image && (
          <span className="block w-full h-28 bg-slate-100">
            <img src={meta.image} alt="" className="w-full h-full object-cover" />
          </span>
        )}
        <span className="block p-2">
          <span className="flex items-center gap-1.5 mb-1">
            {favicon && <img src={favicon} alt="" className="w-4 h-4 rounded" />}
            <span className="text-[10px] font-bold text-slate-500 truncate">{meta?.siteName || domain}</span>
          </span>
          <span className="block text-[11px] font-semibold text-slate-800 leading-snug">{meta?.title || title || domain}</span>
          {meta?.description && (
            <span className="block text-[10px] text-slate-500 leading-snug mt-1 line-clamp-3">{meta.description}</span>
          )}
          <span className="block text-[10px] text-slate-400 break-all mt-1">{url}</span>
        </span>
      </span>
    </a>
  );
};

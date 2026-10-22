// Embed snippet (when the author allows embedding): an escaped <iframe> for the /embed route + Copy.

import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { embedSnippet } from './shareModel';
import { copyText } from './useShareCapabilities';

export const EmbedSnippet: React.FC<{ url: string; title: string; aspect?: string }> = ({ url, title, aspect }) => {
  const code = embedSnippet(url, title, aspect);
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]" htmlFor="ds-embed-code">
        Embed on a website
      </label>
      <div className="flex min-w-0 items-stretch gap-2">
        <textarea
          id="ds-embed-code"
          readOnly
          value={code}
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 resize-none rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-2 font-mono text-[11px] leading-snug text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        />
        <button
          type="button"
          aria-label={copied ? 'Embed code copied' : 'Copy embed code'}
          onClick={async () => setCopied(await copyText(code))}
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        >
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Embed code copied' : ''}
      </span>
    </div>
  );
};

export default EmbedSnippet;

import React, { useState } from 'react';
import { Copy, Check, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { downloadTextFile, languageToExt } from '../../services/chatUtils';

interface CodeBlockProps {
  code: string;
  lang: string;
}

const COLLAPSE_LINES = 24;

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, lang }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lines = code.split('\n');
  const collapsible = lines.length > COLLAPSE_LINES;
  const shown = collapsible && !expanded ? lines.slice(0, COLLAPSE_LINES).join('\n') : code;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const download = () => {
    const ext = languageToExt(lang);
    downloadTextFile(`snippet.${ext}`, code);
  };

  return (
    <div className="my-2 rounded-lg border-2 border-black overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-zinc-800 text-zinc-200 text-[11px] font-mono">
        <span className="uppercase tracking-wide">{lang || 'code'}</span>
        <div className="flex items-center gap-2">
          {collapsible && (
            <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-0.5 hover:text-white" title={expanded ? 'Show less' : 'Show more'}>
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {expanded ? 'Less' : `+${lines.length - COLLAPSE_LINES}`}
            </button>
          )}
          <button onClick={copy} className="flex items-center gap-0.5 hover:text-white" title="Copy code">
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={download} className="flex items-center gap-0.5 hover:text-white" title="Download file">
            <Download className="w-3.5 h-3.5" /> Save
          </button>
        </div>
      </div>
      <pre className="!my-0 !rounded-none !border-0 overflow-x-auto"><code>{shown}{collapsible && !expanded ? '\n…' : ''}</code></pre>
    </div>
  );
};

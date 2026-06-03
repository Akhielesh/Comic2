import React, { useMemo, useState } from 'react';
import { Copy, Check, Download, ChevronDown, ChevronUp, Eye, Code2 } from 'lucide-react';
import { downloadTextFile, languageToExt } from '../../services/chatUtils';

interface CodeBlockProps {
  code: string;
  lang: string;
}

const COLLAPSE_LINES = 24;
const PREVIEWABLE = ['html', 'htm', 'svg', 'xml'];

// Is this block something we can safely render in a sandboxed iframe?
const isPreviewable = (lang: string, code: string): boolean => {
  if (PREVIEWABLE.includes(lang.toLowerCase())) return true;
  return !lang && /^\s*<(!doctype|html|svg|body|div|section|main)/i.test(code);
};

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, lang }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<'code' | 'preview'>('code');

  const previewable = useMemo(() => isPreviewable(lang, code), [lang, code]);
  const previewDoc = useMemo(() => {
    if (!previewable) return '';
    const isSvg = lang.toLowerCase() === 'svg' || /^\s*<svg/i.test(code);
    return isSvg
      ? `<!doctype html><html><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh">${code}</body></html>`
      : code;
  }, [previewable, lang, code]);

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

  const download = () => downloadTextFile(`snippet.${languageToExt(lang)}`, code);

  return (
    <div className="my-2 rounded-lg border-2 border-black overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-zinc-800 text-zinc-200 text-[11px] font-mono">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-wide">{lang || 'code'}</span>
          {previewable && (
            <div className="flex items-center rounded border border-zinc-600 overflow-hidden">
              <button
                onClick={() => setView('code')}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 ${view === 'code' ? 'bg-zinc-600 text-white' : 'hover:text-white'}`}
              >
                <Code2 className="w-3 h-3" /> Code
              </button>
              <button
                onClick={() => setView('preview')}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 ${view === 'preview' ? 'bg-emerald-600 text-white' : 'hover:text-white'}`}
              >
                <Eye className="w-3 h-3" /> Preview
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {collapsible && view === 'code' && (
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

      {view === 'preview' && previewable ? (
        // Sandboxed: scripts run but cannot reach the parent page (no allow-same-origin).
        <iframe
          title="code preview"
          sandbox="allow-scripts"
          srcDoc={previewDoc}
          className="w-full h-72 bg-white border-0"
        />
      ) : (
        <pre className="!my-0 !rounded-none !border-0 overflow-x-auto"><code>{shown}{collapsible && !expanded ? '\n…' : ''}</code></pre>
      )}
    </div>
  );
};

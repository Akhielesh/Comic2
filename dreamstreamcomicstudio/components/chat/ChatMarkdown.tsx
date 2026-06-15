import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { CodeBlock } from './CodeBlock';
import { MarkdownTable } from './MarkdownTable';

// Same sanitize policy as MessageBody, plus <u>.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'u'],
  attributes: { ...defaultSchema.attributes, u: [] }
};

const components: Components = {
  // Fenced/multiline code → rich CodeBlock (copy / download / collapse).
  // Inline code stays a plain <code>.
  code({ className, children }) {
    const text = String(children ?? '').replace(/\n$/, '');
    const match = /language-([\w+#.-]+)/.exec(className || '');
    const multiline = text.includes('\n');
    if (!match && !multiline) {
      return <code className={className}>{children}</code>;
    }
    return <CodeBlock code={text} lang={match ? match[1] : ''} />;
  },
  // CodeBlock renders its own container, so don't wrap it in another <pre>.
  pre({ children }) {
    return <>{children}</>;
  },
  // Replace static GFM tables with an interactive (sortable + searchable) table.
  table({ node, children }) {
    return <MarkdownTable node={node} children={children} />;
  },
  // Open links in a new tab.
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
};

// Hoisted to module scope so ReactMarkdown sees a STABLE plugin-array identity across
// renders. A fresh array literal each render (the old inline `[remarkGfm]` /
// `[[rehypeSanitize, sanitizeSchema]]`) makes react-markdown re-run the whole
// remark→rehype→sanitize parse even when `text` is unchanged.
const REMARK_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [remarkGfm];
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [[rehypeSanitize, sanitizeSchema]];

interface ChatMarkdownProps {
  text: string;
  className?: string;
}

// Memoized: the chat thread re-renders every turn on each streamed token, and without
// this, react-markdown re-parses EVERY prior turn's full body per token (a 40-turn chat
// re-parses ~40 documents per token). Props are two stable primitives (`text`,
// `className`), so default shallow comparison is exactly right — a memo bail skips the
// parse for every turn except the one whose text is actually streaming.
export const ChatMarkdown = React.memo<ChatMarkdownProps>(({ text, className = '' }) => (
  <div className={`message-body ${className}`}>
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {text}
    </ReactMarkdown>
  </div>
));
ChatMarkdown.displayName = 'ChatMarkdown';

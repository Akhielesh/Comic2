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

interface ChatMarkdownProps {
  text: string;
  className?: string;
}

export const ChatMarkdown: React.FC<ChatMarkdownProps> = ({ text, className = '' }) => (
  <div className={`message-body ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  </div>
);

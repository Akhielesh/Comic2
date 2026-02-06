import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'u'],
  attributes: {
    ...defaultSchema.attributes,
    u: []
  }
};

interface MessageBodyProps {
  text: string;
  className?: string;
}

export const MessageBody: React.FC<MessageBodyProps> = ({ text, className = '' }) => {
  return (
    <div className={`message-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};

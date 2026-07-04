import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AIChatMarkdownProps {
  content: string;
  className?: string;
}

const AIChatMarkdown: React.FC<AIChatMarkdownProps> = ({ content, className = '' }) => (
  <div className={`prose prose-sm max-w-none dark:prose-invert ${className}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
  </div>
);

export default memo(AIChatMarkdown);

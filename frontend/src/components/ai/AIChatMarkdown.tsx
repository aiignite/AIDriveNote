import React, { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type AIChatMarkdownVariant = 'default' | 'inverted';

interface AIChatMarkdownProps {
  content: string;
  variant?: AIChatMarkdownVariant;
  className?: string;
}

const MarkdownImagePreview = memo(({ src, alt }: { src?: string; alt?: string }) => {
  const [expanded, setExpanded] = useState(false);
  if (!src) return null;

  return (
    <>
      <img
        src={src}
        alt={alt || 'image'}
        className="my-3 max-w-full cursor-pointer rounded-xl border border-gray-200 transition-opacity hover:opacity-90 dark:border-gray-700"
        onClick={() => setExpanded(true)}
      />
      {expanded ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setExpanded(false)}
        >
          <img src={src} alt={alt || 'image'} className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full p-2 text-white transition-colors hover:bg-white/20"
            onClick={() => setExpanded(false)}
          >
            ✕
          </button>
        </div>
      ) : null}
    </>
  );
});

MarkdownImagePreview.displayName = 'MarkdownImagePreview';

const buildMarkdownComponents = (variant: AIChatMarkdownVariant): Partial<Components> => {
  const isInverted = variant === 'inverted';
  const textMuted = isInverted ? 'text-white/80' : 'text-gray-600 dark:text-gray-400';
  const textStrong = isInverted ? 'text-white' : 'text-gray-900 dark:text-gray-100';
  const codeInline = isInverted
    ? 'rounded bg-white/15 px-1.5 py-0.5 font-mono text-xs text-white'
    : 'rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-red-600 dark:bg-gray-700 dark:text-red-400';
  const codeBlock = isInverted
    ? 'overflow-x-auto rounded-lg bg-black/20 p-3 text-xs text-white'
    : 'overflow-x-auto rounded-lg bg-gray-100 p-3 text-xs dark:bg-gray-700';
  const borderColor = isInverted ? 'border-white/20' : 'border-gray-200 dark:border-gray-700';
  const tableHeadBg = isInverted ? 'bg-white/10' : 'bg-gray-100 dark:bg-gray-800';
  const listClass = isInverted
    ? 'my-2 list-outside space-y-1 pl-5 marker:text-white/70'
    : 'my-2 list-outside space-y-1 pl-5 marker:text-gray-500 dark:marker:text-gray-400';

  return {
    code: ({ inline, className, children, ...props }: React.ComponentProps<'code'> & { inline?: boolean }) => {
      if (inline) {
        return <code className={codeInline} {...props}>{children}</code>;
      }
      return (
        <pre className={codeBlock}>
          <code className={className} {...props}>{children}</code>
        </pre>
      );
    },
    img: ({ src, alt }) => (
      <MarkdownImagePreview src={typeof src === 'string' ? src : undefined} alt={alt} />
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={
          isInverted
            ? 'text-white underline underline-offset-2 hover:text-white/80'
            : 'text-blue-600 underline underline-offset-2 hover:text-blue-700 dark:text-blue-400'
        }
      >
        {children}
      </a>
    ),
    p: ({ children }) => <p className={`my-2 leading-relaxed ${textStrong}`}>{children}</p>,
    ul: ({ children }) => <ul className={`${listClass} list-disc ${textStrong}`}>{children}</ul>,
    ol: ({ children }) => <ol className={`${listClass} list-decimal ${textStrong}`}>{children}</ol>,
    li: ({ children }) => <li className={`leading-relaxed ${textStrong}`}>{children}</li>,
    h1: ({ children }) => <h1 className={`my-3 text-xl font-bold ${textStrong}`}>{children}</h1>,
    h2: ({ children }) => <h2 className={`my-3 text-lg font-bold ${textStrong}`}>{children}</h2>,
    h3: ({ children }) => <h3 className={`my-2 text-base font-semibold ${textStrong}`}>{children}</h3>,
    h4: ({ children }) => <h4 className={`my-2 text-sm font-semibold ${textStrong}`}>{children}</h4>,
    blockquote: ({ children }) => (
      <blockquote className={`my-3 border-l-4 pl-4 italic ${borderColor} ${textMuted}`}>
        {children}
      </blockquote>
    ),
    hr: () => <hr className={`my-4 ${borderColor}`} />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className={`min-w-full border-collapse overflow-hidden rounded-lg border ${borderColor}`}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className={tableHeadBg}>{children}</thead>,
    th: ({ children }) => (
      <th className={`border px-3 py-2 text-left text-sm font-semibold ${borderColor} ${textStrong}`}>
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className={`border px-3 py-2 text-sm ${borderColor} ${textStrong}`}>
        {children}
      </td>
    ),
    strong: ({ children }) => <strong className={`font-semibold ${textStrong}`}>{children}</strong>,
    em: ({ children }) => <em className={textMuted}>{children}</em>,
  };
};

const AIChatMarkdown: React.FC<AIChatMarkdownProps> = ({
  content,
  variant = 'default',
  className = '',
}) => {
  const components = useMemo(() => buildMarkdownComponents(variant), [variant]);
  if (!content.trim()) return null;

  return (
    <div className={`ai-chat-markdown max-w-none ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default memo(AIChatMarkdown);

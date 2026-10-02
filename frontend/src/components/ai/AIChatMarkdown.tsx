/**
 * AIChatMarkdown — AI 回复的 Markdown 渲染
 *
 * 在基础 react-markdown + remark-gfm 之上，增强：
 * - 代码块语法高亮（rehype-highlight）与悬浮复制按钮（CodeBlockShell）；
 * - Mermaid 图表渲染（language === 'mermaid'）；
 * - 图片放大预览与外链白名单；
 * - 自动剥离 ` thinking…` 思考段落（由 ChatThinkingIndicator 单独展示）。
 *
 * 注意：react-markdown v10 不再向 code 组件传递 inline 参数，块级代码统一在
 * pre 层面接管，避免 `<pre>` 被包进 `<p>` 导致 hydration 报错。
 */
import React, { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import { extractThinkingContent } from './ChatThinkingIndicator';

export type AIChatMarkdownVariant = 'default' | 'inverted';

interface AIChatMarkdownProps {
  content: string;
  variant?: AIChatMarkdownVariant;
  className?: string;
}

/**
 * 递归提取 React 子节点中的纯文本，用于复制与 Mermaid 渲染。
 *
 * @param node React 子节点
 * @returns 拼接后的纯文本
 */
function extractText(node: React.ReactNode): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * 判断图片地址是否允许加载（外链白名单，避免加载任意第三方资源）。
 *
 * @param src 图片地址
 * @returns 是否允许
 */
function isAllowedImageSrc(src?: string): boolean {
  if (!src) return false;
  return /^(https?:|data:|blob:|\/)/i.test(src);
}

/** 代码块外壳：语言标签 + 悬浮复制按钮 */
const CodeBlockShell = memo(({
  language,
  rawText,
  children,
}: {
  language?: string;
  rawText: string;
  children: React.ReactNode;
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-gray-700 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-gray-700 bg-gray-800/80 px-3 py-1">
        <span className="text-[11px] font-medium text-gray-400">{language || 'text'}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
          title="复制代码"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">{children}</pre>
    </div>
  );
});

CodeBlockShell.displayName = 'CodeBlockShell';

// Mermaid 只需初始化一次
let mermaidInitialized = false;

/** Mermaid 图表渲染（动态加载 mermaid，失败时展示错误与源码） */
const MermaidDiagram = memo(({ code }: { code: string }) => {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        if (!mermaidInitialized) {
          mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
          mermaidInitialized = true;
        }
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError('');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Mermaid 渲染失败');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/20 dark:text-red-300">
        <p className="mb-1 font-medium">Mermaid 图表渲染失败</p>
        <pre className="overflow-x-auto whitespace-pre-wrap">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-400 dark:border-gray-700 dark:bg-gray-800">
        正在渲染图表…
      </div>
    );
  }

  return (
    <div
      className="my-3 overflow-x-auto rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

MermaidDiagram.displayName = 'MermaidDiagram';

const MarkdownImagePreview = memo(({ src, alt }: { src?: string; alt?: string }) => {
  const [expanded, setExpanded] = useState(false);
  if (!src) return null;

  if (!isAllowedImageSrc(src)) {
    return (
      <span className="my-2 inline-block rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 dark:border-gray-600">
        [已屏蔽外部图片：{alt || src}]
      </span>
    );
  }

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
  const borderColor = isInverted ? 'border-white/20' : 'border-gray-200 dark:border-gray-700';
  const tableHeadBg = isInverted ? 'bg-white/10' : 'bg-gray-100 dark:bg-gray-800';
  const listClass = isInverted
    ? 'my-2 list-outside space-y-1 pl-5 marker:text-white/70'
    : 'my-2 list-outside space-y-1 pl-5 marker:text-gray-500 dark:marker:text-gray-400';

  return {
    // 块级代码统一在 pre 层面接管：提取语言、复制文本并渲染高亮内容
    pre: ({ children }) => {
      const child = React.Children.toArray(children)[0];
      if (!React.isValidElement(child)) {
        return <pre className="my-3 overflow-x-auto rounded-lg bg-[#0d1117] p-3 text-xs text-gray-100">{children}</pre>;
      }
      const childProps = child.props as { className?: string; children?: React.ReactNode };
      const className = typeof childProps.className === 'string' ? childProps.className : '';
      const langMatch = /language-([\w-]+)/.exec(className);
      const lang = langMatch?.[1];
      const rawText = extractText(childProps.children);
      if (lang === 'mermaid') {
        return <MermaidDiagram code={rawText} />;
      }
      return (
        <CodeBlockShell language={lang} rawText={rawText}>
          {child}
        </CodeBlockShell>
      );
    },
    code: ({ className, children, ...props }: React.ComponentProps<'code'>) => {
      const isBlock = typeof className === 'string' && className.includes('language-');
      // 块级代码由 pre 外壳承载样式，这里仅补全高亮类
      if (isBlock) {
        return <code className={`${className} hljs`} {...props}>{children}</code>;
      }
      return <code className={codeInline} {...props}>{children}</code>;
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
  // 剥离  thinking… 段落，思考内容由 ChatThinkingIndicator 单独展示
  const displayContent = useMemo(() => extractThinkingContent(content).answer, [content]);
  if (!displayContent.trim()) return null;

  return (
    <div className={`ai-chat-markdown max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {displayContent}
      </ReactMarkdown>
    </div>
  );
};

export default memo(AIChatMarkdown);
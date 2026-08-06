import { createContext, memo, useCallback, useContext, useMemo, useState } from 'react';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
  variant: 'user' | 'assistant' | 'compact';
  /** 代码块复制按钮的 blockId 前缀（assistant 变体需要）；不传则代码块不显示复制按钮 */
  blockIdPrefix?: string;
  /** 外层容器额外 className（透传到 markdown-body 容器） */
  className?: string;
}

/** 从 react-markdown 的 children 节点中递归提取纯文本（用于代码块复制） */
function extractCodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractCodeText((node as any).props.children);
  }
  return '';
}

/** assistant 变体的代码块需要访问实例级复制状态，通过 context 下发 */
interface AssistantContextValue {
  blockIdPrefix?: string;
  copiedId: string | null;
  handleCopyCode: (text: string, id: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

function useAssistantContext(): AssistantContextValue {
  // 仅 assistant 变体的代码块组件会调用；缺省时兜底为不可复制状态
  return useContext(AssistantContext) ?? { blockIdPrefix: undefined, copiedId: null, handleCopyCode: () => {} };
}

// ---- 模块级常量：插件与 components 映射引用稳定，避免每次渲染重建导致整棵 markdown 树重渲染 ----

/** user 变体 remarkPlugins：GFM + 保留换行 */
const USER_REMARK_PLUGINS: MarkdownOptions['remarkPlugins'] = [remarkGfm, remarkBreaks];
/** assistant / compact 变体 remarkPlugins */
const PLAIN_REMARK_PLUGINS: MarkdownOptions['remarkPlugins'] = [remarkGfm];
/** 所有变体共用 rehypePlugins */
const REHYPE_PLUGINS: MarkdownOptions['rehypePlugins'] = [[rehypeHighlight, { detect: false }]];

/** user 变体：蓝色用户气泡配置（无代码块复制按钮，含表格、图片） */
const USER_COMPONENTS = {
  pre({ children }: any) {
    return <pre className="overflow-x-auto">{children}</pre>;
  },
  code({ className, children, ...codeProps }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !className;
    if (!isInline) {
      const language = match ? match[1] : 'code';
      return (
        <div className="my-2 border border-blue-400/40 rounded-xl overflow-hidden bg-blue-700/60 text-white max-w-full">
          <div className="bg-blue-800/60 px-3 py-1 flex items-center border-b border-blue-400/30">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-blue-200">{language}</span>
          </div>
          <pre className="p-3 overflow-x-auto text-[11.5px] leading-relaxed text-white/90">
            <code className={className}>{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <code className="bg-blue-500/60 border border-blue-400/40 text-white px-1.5 py-0.5 rounded font-mono text-[11px]" {...codeProps}>
        {children}
      </code>
    );
  },
  p({ children, ...pProps }: any) {
    return <p className="my-1.5 leading-relaxed" {...pProps}>{children}</p>;
  },
  ul({ children, ...ulProps }: any) {
    return <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...ulProps}>{children}</ul>;
  },
  ol({ children, ...olProps }: any) {
    return <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...olProps}>{children}</ol>;
  },
  blockquote({ children, ...bqProps }: any) {
    return <blockquote className="border-l-3 border-blue-400/60 pl-3 py-1 my-2 opacity-90" {...bqProps}>{children}</blockquote>;
  },
  a({ children, href, ...aProps }: any) {
    return <a href={href} className="underline underline-offset-2 hover:opacity-80" target="_blank" rel="noopener noreferrer" {...aProps}>{children}</a>;
  },
  table({ children, ...tableProps }: any) {
    return (
      <div className="overflow-x-auto my-2 rounded-lg border border-blue-400/40">
        <table className="min-w-full text-xs border-collapse" {...tableProps}>{children}</table>
      </div>
    );
  },
  thead({ children, ...theadProps }: any) {
    return <thead className="bg-blue-700/60" {...theadProps}>{children}</thead>;
  },
  tbody({ children, ...tbodyProps }: any) {
    return <tbody className="divide-y divide-blue-400/20" {...tbodyProps}>{children}</tbody>;
  },
  tr({ children, ...trProps }: any) {
    return <tr className="even:bg-blue-500/20" {...trProps}>{children}</tr>;
  },
  th({ children, ...thProps }: any) {
    return <th className="px-2.5 py-1.5 text-left font-semibold text-white/90 border-b border-blue-400/40 text-[11px]" {...thProps}>{children}</th>;
  },
  td({ children, ...tdProps }: any) {
    return <td className="px-2.5 py-1.5 text-white/80 border-b border-blue-400/20 text-[11px]" {...tdProps}>{children}</td>;
  },
  h1({ children, ...hProps }: any) {
    return <h1 className="text-base font-bold my-2" {...hProps}>{children}</h1>;
  },
  h2({ children, ...hProps }: any) {
    return <h2 className="text-sm font-bold my-1.5" {...hProps}>{children}</h2>;
  },
  h3({ children, ...hProps }: any) {
    return <h3 className="text-sm font-semibold my-1.5" {...hProps}>{children}</h3>;
  },
  hr() {
    return <hr className="border-blue-400/40 my-2" />;
  },
  img({ src, alt, ...imgProps }: any) {
    return <img src={src} alt={alt} className="max-w-full rounded-lg my-1.5" style={{ aspectRatio: 'auto' }} loading="lazy" {...imgProps} />;
  },
};

/** assistant 变体：普通消息块 + streaming 块共用配置（含代码块复制按钮、表格、引用等） */
const ASSISTANT_COMPONENTS = {
  pre({ children }: any) {
    return <pre className="code-block">{children}</pre>;
  },
  code({ className, children, ...codeProps }: any) {
    const { blockIdPrefix, copiedId, handleCopyCode } = useAssistantContext();
    const match = /language-(\w+)/.exec(className || '');
    const codeText = extractCodeText(children).replace(/\n$/, '');
    const isInline = !className;

    if (!isInline) {
      const language = match ? match[1] : 'code';
      const blockId = `${blockIdPrefix}-${language}-${codeText}`;
      return (
        <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900 relative font-mono text-xs shadow-3xs max-w-full">
          <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">{language}</span>
            {blockIdPrefix !== undefined && (
              <button
                type="button"
                onClick={() => handleCopyCode(codeText, blockId)}
                className="flex items-center space-x-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 px-2.5 py-1 rounded text-[11px] text-slate-600 dark:text-slate-300 font-sans cursor-pointer transition-colors"
              >
                {copiedId === blockId ? (
                  <>
                    <Check className="w-3 h-3 text-green-600" />
                    <span className="text-green-600 font-medium">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            )}
          </div>
          <pre className="p-4 overflow-x-auto text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-950">
            <code className={className}>{children}</code>
          </pre>
        </div>
      );
    }

    return (
      <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold" {...codeProps}>
        {children}
      </code>
    );
  },
  p({ children, ...props }: any) {
    return <p className="text-slate-700 dark:text-slate-300 leading-relaxed my-2 text-[13.5px]" {...props}>{children}</p>;
  },
  ul({ children, ...props }: any) {
    return <ul className="list-disc pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ul>;
  },
  ol({ children, ...props }: any) {
    return <ol className="list-decimal pl-5 my-2 text-xs text-slate-700 dark:text-slate-300 space-y-1" {...props}>{children}</ol>;
  },
  blockquote({ children, ...props }: any) {
    return <blockquote className="border-l-4 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 pl-3.5 py-1.5 my-3 italic text-slate-600 dark:text-slate-400 rounded-r-lg" {...props}>{children}</blockquote>;
  },
  table({ children, ...props }: any) {
    return (
      <div className="overflow-x-auto my-3 rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="min-w-full text-xs border-collapse" {...props}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, ...props }: any) {
    return <thead className="bg-slate-50 dark:bg-slate-800" {...props}>{children}</thead>;
  },
  tbody({ children, ...props }: any) {
    return <tbody className="divide-y divide-slate-200 dark:divide-slate-700" {...props}>{children}</tbody>;
  },
  tr({ children, ...props }: any) {
    return <tr className="even:bg-slate-50/50 dark:even:bg-slate-800/50" {...props}>{children}</tr>;
  },
  th({ children, ...props }: any) {
    return <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700 text-[12px]" {...props}>{children}</th>;
  },
  td({ children, ...props }: any) {
    return <td className="px-3 py-2 text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800 text-[12px]" {...props}>{children}</td>;
  },
};

/** compact 变体：spawn summary 配置（indigo 系，无表格，无复制按钮） */
const COMPACT_COMPONENTS = {
  p({ children }: any) {
    return <p className="text-slate-700 dark:text-slate-300 leading-relaxed my-1.5 text-[13.5px]">{children}</p>;
  },
  ul({ children }: any) {
    return <ul className="list-disc pl-5 my-1.5 text-xs text-slate-700 dark:text-slate-300 space-y-0.5">{children}</ul>;
  },
  ol({ children }: any) {
    return <ol className="list-decimal pl-5 my-1.5 text-xs text-slate-700 dark:text-slate-300 space-y-0.5">{children}</ol>;
  },
  code({ className, children, ...codeProps }: any) {
    const isInline = !className;
    if (isInline) {
      return <code className="bg-slate-100 dark:bg-slate-800 border border-slate-150 dark:border-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold" {...codeProps}>{children}</code>;
    }
    return <code className={`${className ?? ''} text-[11.5px]`} {...codeProps}>{children}</code>;
  },
  pre({ children }: any) {
    return <pre className="code-block my-2 overflow-x-auto text-[11.5px] leading-relaxed">{children}</pre>;
  },
  blockquote({ children }: any) {
    return <blockquote className="border-l-3 border-indigo-300 dark:border-indigo-700 pl-3 py-1 my-2 text-slate-600 dark:text-slate-400 text-xs">{children}</blockquote>;
  },
  h1({ children }: any) {
    return <h1 className="text-base font-bold my-2 text-slate-800 dark:text-slate-200">{children}</h1>;
  },
  h2({ children }: any) {
    return <h2 className="text-sm font-bold my-1.5 text-slate-800 dark:text-slate-200">{children}</h2>;
  },
  h3({ children }: any) {
    return <h3 className="text-sm font-semibold my-1 text-slate-800 dark:text-slate-200">{children}</h3>;
  },
  a({ children, href, ...aProps }: any) {
    return <a href={href} className="underline underline-offset-2 text-indigo-600 dark:text-indigo-400" target="_blank" rel="noopener noreferrer" {...aProps}>{children}</a>;
  },
  hr() {
    return <hr className="border-slate-200 dark:border-slate-700 my-2" />;
  },
};

/**
 * 共享 Markdown 渲染组件：将 TabChat 中 4 份重复的 ReactMarkdown 配置收敛为 3 个主题变体。
 * components 映射为模块级常量（引用稳定），避免每次渲染重建匿名组件导致整棵 markdown 树重渲染。
 */
function MarkdownRenderer({ content, variant, blockIdPrefix, className }: MarkdownRendererProps): JSX.Element {
  // 代码块复制状态（每实例独立）
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyCode = useCallback(async (text: string, id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopiedId(null);
    }
  }, []);

  // 复制状态变化只影响代码块组件（context 消费者），不触发整棵 markdown 树重渲染
  const assistantCtx = useMemo(
    () => ({ blockIdPrefix, copiedId, handleCopyCode }),
    [blockIdPrefix, copiedId, handleCopyCode],
  );

  const remarkPlugins = variant === 'user' ? USER_REMARK_PLUGINS : PLAIN_REMARK_PLUGINS;
  const components = variant === 'user'
    ? USER_COMPONENTS
    : variant === 'assistant'
      ? ASSISTANT_COMPONENTS
      : COMPACT_COMPONENTS;

  const markdown = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );

  const wrapped = (
    <div className={`markdown-body${className ? ` ${className}` : ''}`}>
      {markdown}
    </div>
  );

  if (variant !== 'assistant') return wrapped;

  return (
    <AssistantContext.Provider value={assistantCtx}>
      {wrapped}
    </AssistantContext.Provider>
  );
}

export default memo(MarkdownRenderer);

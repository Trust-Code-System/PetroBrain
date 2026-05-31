'use client';

import type * as React from 'react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface CopyButtonProps {
  getText: () => string;
  label?: string;
}

function CopyButton({ getText, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard API can fail in insecure contexts - fall back to a temp textarea.
      const ta = document.createElement('textarea');
      ta.value = getText();
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-700/40 bg-neutral-800/40 px-2 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700/60 hover:text-white"
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
            <path
              d="M4 10.5L8 14.5L16 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
            <rect
              x="6"
              y="6"
              width="10"
              height="10"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M4 14V5.5A1.5 1.5 0 015.5 4H14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function nodeToString(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeToString).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: unknown } }).props;
    return nodeToString(props?.children ?? '');
  }
  return '';
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-relaxed text-neutral-800 dark:text-neutral-200">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-neutral-900 dark:text-neutral-100">{children}</strong>,
  em: ({ children }) => <em className="italic text-neutral-800 dark:text-neutral-200">{children}</em>,
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 text-neutral-800 marker:text-primary-400 dark:text-neutral-200 dark:marker:text-primary-500">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 text-neutral-800 marker:font-semibold marker:text-primary-500 dark:text-neutral-200 dark:marker:text-primary-400">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary-700 underline decoration-primary-300 underline-offset-2 hover:decoration-primary-500 dark:text-primary-300 dark:decoration-primary-700 dark:hover:decoration-primary-500"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary-300 bg-primary-50/40 px-3 py-1 text-neutral-700 dark:border-primary-600 dark:bg-primary-900/20 dark:text-neutral-300">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-neutral-200 dark:border-neutral-800" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-neutral-50 dark:bg-neutral-900/60">{children}</thead>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2 text-neutral-800 dark:text-neutral-200">{children}</td>,
  tr: ({ children }) => <tr className="even:bg-neutral-50/40 dark:even:bg-neutral-900/30">{children}</tr>,
  code: (props) => {
    const { className, children } = props as { className?: string; children?: unknown };
    const inline = (props as { inline?: boolean }).inline === true;
    const match = /language-(\w+)/.exec(className ?? '');
    const text = nodeToString(children).replace(/\n$/, '');

    if (inline || !match) {
      return (
        <code className="rounded-md border border-neutral-200 bg-neutral-100/80 px-1.5 py-0.5 font-mono text-[0.85em] text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-100">
          {text || (children as React.ReactNode)}
        </code>
      );
    }

    return (
      <div className="my-3 overflow-hidden rounded-xl border border-neutral-800/60 bg-[#0f172a] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.4)]">
        <div className="flex items-center justify-between border-b border-neutral-800/60 bg-[#111a2e] px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
            {match[1]}
          </span>
          <CopyButton getText={() => text} />
        </div>
        <pre className="m-0 max-h-[28rem] overflow-auto bg-transparent p-3 text-[12.5px] leading-relaxed">
          <code className={`font-mono text-neutral-100 ${className ?? ''}`}>
            {text || (children as React.ReactNode)}
          </code>
        </pre>
      </div>
    );
  },
  pre: ({ children }) => <>{children}</>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[15px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

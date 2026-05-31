import Link from 'next/link';

import { Banner, Logo } from '@petrobrain/ui';

const SURFACES: Array<{
  href: '/chat' | '/emissions' | '/admin/documents';
  title: string;
  description: string;
  cta: string;
  icon: 'chat' | 'leaf' | 'doc';
}> = [
  {
    href: '/chat',
    title: 'Chat',
    description: 'Guardrailed domain chat with streaming answers + citations.',
    cta: 'Open chat',
    icon: 'chat',
  },
  {
    href: '/emissions',
    title: 'Emissions MRV',
    description: 'NUPRC Tier-3 inventory dashboard.',
    cta: 'Open MRV',
    icon: 'leaf',
  },
  {
    href: '/admin/documents',
    title: 'Documents',
    description: 'Upload + track SOP ingestion.',
    cta: 'Open documents',
    icon: 'doc',
  },
];

function SurfaceIcon({ kind }: { kind: 'chat' | 'leaf' | 'doc' }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 20 20',
    fill: 'none',
    'aria-hidden': true,
  } as const;
  if (kind === 'chat') {
    return (
      <svg {...common}>
        <path
          d="M4 5.5A2.5 2.5 0 016.5 3h7A2.5 2.5 0 0116 5.5v6A2.5 2.5 0 0113.5 14H9l-3.2 2.8a.5.5 0 01-.8-.4V14H6.5A2.5 2.5 0 014 11.5v-6z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'leaf') {
    return (
      <svg {...common}>
        <path
          d="M16 4c0 7-5 12-12 12 0-7 5-12 12-12zM4 16l6-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M6 3h6l4 4v9a1.5 1.5 0 01-1.5 1.5h-8.5A1.5 1.5 0 014.5 16V4.5A1.5 1.5 0 016 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 3v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-100/40 blur-3xl dark:bg-primary-900/20"
      />

      <div className="relative mx-auto max-w-5xl px-6 py-14">
        <header className="flex flex-col items-center gap-5 text-center">
          <div className="relative">
            <div
              aria-hidden
              className="absolute inset-0 -z-10 rounded-full bg-gradient-to-br from-primary-200/60 via-primary-300/30 to-transparent blur-2xl dark:from-primary-700/40 dark:via-primary-800/20"
            />
            <Logo size={88} glow />
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-600 dark:text-primary-400">
            PetroBrain - Operations Copilot
          </p>
          <h1 className="bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-600 bg-clip-text text-4xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:via-neutral-200 dark:to-neutral-400 sm:text-5xl">
            Domain-locked oil &amp; gas operations console.
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            Grounded in your tenant&apos;s SOPs, standards and emissions data. Numbers come from
            calculation tools - never from prose.
          </p>
        </header>

        <div className="mx-auto mt-10 max-w-3xl">
          <Banner tone="info" title="DECISION SUPPORT ONLY">
            Verify all safety-critical numbers with the competent person before acting.
          </Banner>
        </div>

        <section className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
          {SURFACES.map((s) => (
            <Link
              key={s.href}
              href={{ pathname: s.href, query: { from: 'home' } }}
              className="group relative overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-brand-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary-300/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100 dark:via-primary-500/60"
              />
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary-50 to-primary-100 text-primary-600 ring-1 ring-primary-200/60 transition-colors group-hover:from-primary-100 group-hover:to-primary-200 dark:from-primary-900/40 dark:to-primary-800/40 dark:text-primary-300 dark:ring-primary-700/40 dark:group-hover:from-primary-800/50 dark:group-hover:to-primary-700/50">
                <SurfaceIcon kind={s.icon} />
              </div>
              <h2 className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{s.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{s.description}</p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 dark:text-primary-300">
                {s.cta}
                <svg
                  aria-hidden
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                  fill="none"
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  <path
                    d="M5 10h10M11 6l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}

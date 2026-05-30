const SUGGESTIONS = [
  {
    title: 'Build a kill sheet',
    body: 'Well-control kill sheet from well + influx parameters.',
    prompt:
      'Build a kill sheet for 10,000 ft TVD, OMW 9.6 ppg, SIDPP 400 psi, SICP 600 psi, pit gain 20 bbl.',
  },
  {
    title: 'Summarize an SOP',
    body: 'Key steps + verification points from your tenant SOPs.',
    prompt: 'Summarize the key steps and verification points in our well-control handover SOP.',
  },
  {
    title: 'Tier-3 MRV gaps',
    body: 'Sources not yet on measurement-based Tier 3.',
    prompt:
      'Which of our emission sources are not yet on measurement-based Tier 3, against the Jan-2027 deadline?',
  },
];

export function EmptyState({ onPrompt }: { onPrompt?: (text: string) => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 px-6 py-12 text-center">
      <div
        aria-hidden
        className="h-20 w-20 rounded-full bg-gradient-to-br from-primary-300 via-primary-500 to-primary-700 shadow-lg"
      />
      <div className="space-y-1">
        <p className="text-lg font-medium text-primary-600">PetroBrain</p>
        <h2 className="text-2xl font-semibold text-neutral-800">
          How can I help with your operations today?
        </h2>
        <p className="mx-auto max-w-md text-sm text-neutral-500">
          Grounded in your tenant&apos;s SOPs, standards, and emissions data. Numbers come from the
          calculation tools — never from prose.
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPrompt?.(s.prompt)}
            disabled={!onPrompt}
            className="rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition hover:border-primary-300 hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:cursor-default"
          >
            <p className="text-sm font-semibold text-neutral-800">{s.title}</p>
            <p className="mt-1 text-xs text-neutral-500">{s.body}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

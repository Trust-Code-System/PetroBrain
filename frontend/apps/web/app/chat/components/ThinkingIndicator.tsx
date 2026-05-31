'use client';

/**
 * Claude/ChatGPT-style "thinking" state. Shown on an assistant turn that
 * has streaming=true but hasn't produced any tokens yet. Renders a
 * shimmering "Thinking" label next to three staggered pulsing dots.
 */
export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2.5 py-1" aria-live="polite" aria-label="PetroBrain is thinking">
      <span className="pb-thinking-shimmer bg-[length:200%_100%] bg-clip-text text-[15px] font-medium text-transparent animate-pb-shimmer">
        Thinking
      </span>
      <span className="flex items-center gap-1" aria-hidden>
        <span
          className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-pb-thinking"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-pb-thinking"
          style={{ animationDelay: '180ms' }}
        />
        <span
          className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-pb-thinking"
          style={{ animationDelay: '360ms' }}
        />
      </span>
    </div>
  );
}

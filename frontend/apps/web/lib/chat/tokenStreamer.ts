/**
 * Paced token renderer used by ChatClient.
 *
 * SSE token events arrive in bursts - sometimes one character at a time,
 * sometimes 20+ characters in a single chunk after the model finishes a
 * sentence. Rendering each event immediately produces a choppy "type and
 * stall" effect; rendering everything as soon as it arrives feels
 * instantaneous and loses the visual cue that the model is composing.
 *
 * This streamer buffers incoming text and consumes it at a target rate
 * (default ~250 chars/sec, comfortable above natural reading speed).
 * When the buffer falls behind by enough that it would noticeably trail
 * the actual stream, the per-frame budget scales up so the cursor catches
 * up rather than holding the user in suspense.
 *
 * Semantics:
 *   - push(text) - append text to the buffer; schedule a frame.
 *   - flush()    - deliver everything still in the buffer immediately.
 *                  Called on 'done' so the final assistant text is whole
 *                  before downstream logic (canvas auto-open, notifications,
 *                  feedback chip activation) reads it.
 *   - stop()     - drop whatever's buffered. Called when the stream errors
 *                  out and the partial chars should not appear.
 */

export interface TokenStreamerOptions {
  /** Called whenever chars come out of the buffer. */
  applyChars: (chars: string) => void;
  /** Target characters per second under normal pace. Default 250. */
  charsPerSecond?: number;
  /** Max characters delivered in one normal frame before acceleration
   *  kicks in for a backed-up buffer. Default 24. */
  maxCharsPerFrame?: number;
  /** Override the rAF scheduler - tests inject a synchronous stepper. */
  scheduler?: Scheduler;
}

export interface Scheduler {
  schedule: (cb: (now: number) => void) => unknown;
  cancel: (id: unknown) => void;
}

export interface TokenStreamer {
  push(text: string): void;
  flush(): void;
  stop(): void;
  /** True while there are chars buffered or a frame is scheduled. */
  isActive(): boolean;
}

export function createTokenStreamer(opts: TokenStreamerOptions): TokenStreamer {
  const charsPerSecond = opts.charsPerSecond ?? 250;
  const maxCharsPerFrame = opts.maxCharsPerFrame ?? 24;
  const sched = opts.scheduler ?? defaultScheduler();

  let buffer = '';
  let scheduledId: unknown = null;
  let lastTick = 0;

  function schedule(): void {
    if (scheduledId != null) return;
    scheduledId = sched.schedule(tick);
  }

  function tick(now: number): void {
    scheduledId = null;
    if (!buffer) return;
    const dt = lastTick === 0 ? 16 : Math.max(1, now - lastTick);
    lastTick = now;
    const budget = Math.max(1, Math.round((charsPerSecond * dt) / 1000));
    // Acceleration: when the buffer is large (model bursting ahead),
    // deliver chars faster to catch up. Capped at 4x the normal frame
    // budget so even a giant flush still gets a couple of frames of
    // motion - feels paced rather than flashing in all at once.
    const accel = Math.ceil(buffer.length / 30);
    const target = Math.min(maxCharsPerFrame * 4, Math.max(budget, accel));
    const chars = Math.min(buffer.length, target);
    const head = buffer.slice(0, chars);
    buffer = buffer.slice(chars);
    opts.applyChars(head);
    if (buffer) schedule();
  }

  return {
    push(text: string): void {
      if (!text) return;
      buffer += text;
      schedule();
    },
    flush(): void {
      if (scheduledId != null) {
        sched.cancel(scheduledId);
        scheduledId = null;
      }
      if (buffer) {
        opts.applyChars(buffer);
        buffer = '';
      }
      lastTick = 0;
    },
    stop(): void {
      if (scheduledId != null) {
        sched.cancel(scheduledId);
        scheduledId = null;
      }
      buffer = '';
      lastTick = 0;
    },
    isActive(): boolean {
      return buffer.length > 0 || scheduledId != null;
    },
  };
}

function defaultScheduler(): Scheduler {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    // SSR / tests without rAF - tick on a 16ms setTimeout.
    return {
      schedule: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown,
      cancel: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
  }
  return {
    schedule: (cb) => window.requestAnimationFrame(cb),
    cancel: (id) => window.cancelAnimationFrame(id as number),
  };
}

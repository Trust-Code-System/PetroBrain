/**
 * Paced token-render streamer behaviour. Uses an injectable scheduler so
 * we can step frames synchronously without needing fake timers.
 */
import { describe, expect, it } from 'vitest';

import { createTokenStreamer, type Scheduler } from './tokenStreamer';

/** Synchronous scheduler - tick() runs queued callbacks at a given timestamp. */
function makeStepper(): { sched: Scheduler; step: (ms?: number) => void; now: () => number } {
  const queue: Array<(now: number) => void> = [];
  let counter = 0;
  let clock = 0;
  const sched: Scheduler = {
    schedule: (cb) => {
      queue.push(cb);
      counter += 1;
      return counter;
    },
    cancel: () => {
      // Drain - tests don't run cancelled frames.
      queue.length = 0;
    },
  };
  function step(ms = 16): void {
    clock += ms;
    const ready = queue.splice(0, queue.length);
    for (const cb of ready) cb(clock);
  }
  return { sched, step, now: () => clock };
}

describe('createTokenStreamer', () => {
  it('paces incoming tokens across multiple frames', () => {
    const { sched, step } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      charsPerSecond: 250,
      scheduler: sched,
    });

    // 100 chars arrive in one push.
    streamer.push('a'.repeat(100));

    // First frame can't be instant - normal budget for one 16ms frame at
    // 250cps is ~4 chars. Acceleration for a 100-char buffer kicks in
    // (ceil(100 / 30) = 4) so we expect a small number per tick.
    step();
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]!.length).toBeLessThan(100);

    // After enough frames the whole 100 chars are delivered.
    for (let i = 0; i < 30; i += 1) step();
    expect(applied.join('').length).toBe(100);
  });

  it('flush() delivers everything still buffered immediately', () => {
    const { sched } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      scheduler: sched,
    });

    streamer.push('Hello world! 12345');
    // Don't step any frames - the buffer is still full.
    streamer.flush();
    expect(applied.join('')).toBe('Hello world! 12345');
  });

  it('stop() drops what is buffered (used on abort)', () => {
    const { sched } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      scheduler: sched,
    });
    streamer.push('this should never land');
    streamer.stop();
    // Stepping after stop must not deliver anything either.
    for (let i = 0; i < 5; i += 1) {
      // Use a fresh stepper since the original one's queue was cancelled.
    }
    expect(applied.join('')).toBe('');
    expect(streamer.isActive()).toBe(false);
  });

  it('accelerates when the buffer grows large mid-stream', () => {
    const { sched, step } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      charsPerSecond: 100,
      maxCharsPerFrame: 24,
      scheduler: sched,
    });
    // Big initial burst - 800 chars.
    streamer.push('x'.repeat(800));
    // First tick should grab more than the normal 100cps * 16ms ~= 2 char
    // budget thanks to the buffer-size acceleration term.
    step();
    expect(applied[0]!.length).toBeGreaterThan(2);
  });

  it('subsequent pushes after a flush schedule a new frame', () => {
    const { sched, step } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      scheduler: sched,
    });
    streamer.push('first');
    streamer.flush();
    expect(applied.join('')).toBe('first');

    streamer.push('second');
    expect(streamer.isActive()).toBe(true);
    for (let i = 0; i < 20; i += 1) step();
    expect(applied.join('')).toBe('firstsecond');
  });

  it('isActive() reflects buffered + scheduled state', () => {
    const { sched } = makeStepper();
    const applied: string[] = [];
    const streamer = createTokenStreamer({
      applyChars: (chars) => applied.push(chars),
      scheduler: sched,
    });
    expect(streamer.isActive()).toBe(false);
    streamer.push('hi');
    expect(streamer.isActive()).toBe(true);
    streamer.flush();
    expect(streamer.isActive()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  consumeSse,
  SessionExpiredError,
  sessionExpiredKind,
  type StreamEvent,
} from './streamChat.js';

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('consumeSse', () => {
  it('parses one event per record', async () => {
    const stream = makeStream([
      'event: token\ndata: {"text":"hello"}\n\n',
      'event: done\ndata: {"answer":"hi","tool_results":[],"flags":[],"audit":{}}\n\n',
    ]);

    const out: StreamEvent[] = [];
    await consumeSse(stream, (e) => out.push(e));

    expect(out.map((e) => e.event)).toEqual(['token', 'done']);
    expect(out[0]).toEqual({ event: 'token', data: { text: 'hello' } });
  });

  it('handles records split across chunks', async () => {
    // The token record is split mid-data; the parser must wait for the blank line.
    const stream = makeStream([
      'event: tok',
      'en\ndata: {"text":"par',
      't1"}\n\nevent: token\ndata: ',
      '{"text":"part2"}\n\n',
    ]);
    const out: StreamEvent[] = [];
    await consumeSse(stream, (e) => out.push(e));
    expect(out).toEqual([
      { event: 'token', data: { text: 'part1' } },
      { event: 'token', data: { text: 'part2' } },
    ]);
  });

  it('parses tool_call, tool_result, citation, flag, done in order', async () => {
    const records = [
      'event: tool_call\ndata: {"tool":"build_kill_sheet","id":"t1","input":{"tvd_ft":10000}}',
      'event: tool_result\ndata: {"tool":"build_kill_sheet","result":{"kill_mud_weight_ppg":10.37}}',
      'event: citation\ndata: {"title":"Kick SOP","revision":"Rev 1","clause":"2.1"}',
      'event: flag\ndata: {"flag":"missing_safety_banner"}',
      'event: done\ndata: {"answer":"ok","tool_results":[],"flags":[],"audit":{}}',
    ];
    const stream = makeStream([records.join('\n\n') + '\n\n']);
    const out: StreamEvent[] = [];
    await consumeSse(stream, (e) => out.push(e));
    expect(out.map((e) => e.event)).toEqual([
      'tool_call',
      'tool_result',
      'citation',
      'flag',
      'done',
    ]);
  });

  it('parses typed progress events without exposing the payload as text', async () => {
    const stream = makeStream([
      'event: status\ndata: {"type":"status","step_id":"plan","status":"running","message":"Planning research steps...","timestamp":"2026-06-06T10:00:00Z"}\n\n',
      'event: source_found\ndata: {"type":"source_found","step_id":"source_search","status":"running","message":"Found NUPRC source","timestamp":"2026-06-06T10:00:01Z","source":{"title":"NUPRC","url":"https://nuprc.gov.ng"}}\n\n',
    ]);
    const out: StreamEvent[] = [];

    await consumeSse(stream, (event) => out.push(event));

    expect(out.map((event) => event.event)).toEqual(['status', 'source_found']);
    expect(out[1]?.data).toMatchObject({
      step_id: 'source_search',
      source: { title: 'NUPRC' },
    });
  });

  it('ignores malformed records without throwing', async () => {
    const stream = makeStream(['event: token\ndata: not-json\n\n', 'event: token\ndata: {"text":"ok"}\n\n']);
    const out: StreamEvent[] = [];
    await consumeSse(stream, (e) => out.push(e));
    expect(out).toEqual([{ event: 'token', data: { text: 'ok' } }]);
  });
});

/**
 * Classification of the 401 detail shapes used by app/api/deps.py::get_principal.
 * Keeps the frontend's "session expired" detection in sync with what the
 * backend actually says, so an admin tweaking the detail strings on the
 * server can't silently break the polish flow.
 */
describe('sessionExpiredKind', () => {
  it('classifies a 401 token-expired payload as expired', () => {
    expect(sessionExpiredKind(401, '{"detail":"token expired"}')).toBe('expired');
  });

  it('classifies a 401 token-revoked payload as revoked', () => {
    expect(sessionExpiredKind(401, '{"detail":"token revoked"}')).toBe('revoked');
  });

  it('classifies invalid / missing credentials as invalid', () => {
    expect(sessionExpiredKind(401, '{"detail":"invalid credentials"}')).toBe('invalid');
    expect(sessionExpiredKind(401, '{"detail":"missing credentials"}')).toBe('invalid');
  });

  it('returns null for an unrecognised 401 detail string', () => {
    expect(sessionExpiredKind(401, '{"detail":"some other 401 reason"}')).toBeNull();
  });

  it('returns null for non-401 status codes even when the detail says expired', () => {
    expect(sessionExpiredKind(500, '{"detail":"token expired"}')).toBeNull();
    expect(sessionExpiredKind(403, '{"detail":"token expired"}')).toBeNull();
  });

  it('handles a missing detail body gracefully', () => {
    expect(sessionExpiredKind(401, '')).toBeNull();
  });
});

describe('SessionExpiredError', () => {
  it('carries the classification reason so the UI can show specific copy', () => {
    const err = new SessionExpiredError('revoked');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('revoked');
    expect(err.name).toBe('SessionExpiredError');
  });

  it('defaults to expired when no reason is supplied', () => {
    const err = new SessionExpiredError();
    expect(err.reason).toBe('expired');
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyEvent } from '../ChatClient';
import type { AssistantMessage, Message as MessageType } from '@/lib/chat/types';
import type { StreamEvent } from '@/lib/chat/streamChat';

import { Message, speechTextFromMarkdown } from './Message';

const ASSISTANT_ID = 'assistant-1';

afterEach(() => {
  vi.unstubAllGlobals();
});

function blankAssistant(): AssistantMessage {
  return {
    id: ASSISTANT_ID,
    role: 'assistant',
    text: '',
    citations: [],
    toolResults: [],
    evidencePack: null,
    flags: [],
    streaming: true,
    createdAt: 0,
  };
}

function drive(events: StreamEvent[]): MessageType {
  let messages: MessageType[] = [blankAssistant()];
  for (const e of events) {
    messages = applyEvent(messages, ASSISTANT_ID, e);
  }
  return messages[0]!;
}

describe('Message - kill-sheet stream', () => {
  const killSheetResult = {
    method: 'wait_and_weight',
    banner: 'DECISION SUPPORT ONLY. Verify with the competent person before action.',
    kill_mud_weight_ppg: 10.37,
    initial_circulating_pressure_psi: 1200,
    working: [
      'KMW = OMW + SIDPP / (0.052 × TVD)',
      'KMW = 9.6 + 400 / (0.052 × 10000) = 10.37 ppg',
    ],
  };

  const events: StreamEvent[] = [
    {
      event: 'tool_call',
      data: { tool: 'build_kill_sheet', id: 't1', input: { tvd_ft: 10000, omw_ppg: 9.6 } },
    },
    { event: 'tool_result', data: { tool: 'build_kill_sheet', result: killSheetResult } },
    {
      event: 'citation',
      data: {
        title: 'Kick SOP',
        revision: 'Rev 1',
        clause: '2.1',
        reliability: 'primary',
      },
    },
    { event: 'token', data: { text: 'Kill mud weight is 10.37 ppg. Verify before pumping.' } },
    {
      event: 'done',
      data: {
        answer: 'Kill mud weight is 10.37 ppg. Verify before pumping.',
        tool_results: [
          {
            tool: 'build_kill_sheet',
            input: { tvd_ft: 10000, omw_ppg: 9.6 },
            result: killSheetResult,
          },
        ],
        flags: [],
        evidence_pack: {
          confidence: { label: 'Medium', reason: 'Some supporting evidence is present, with noted gaps.' },
          checked: ['1 deterministic calculation used.'],
          not_verified: ['No uploaded SOP or procedure citation was used.'],
          sources: [],
          calculations: [
            {
              label: 'Kill sheet calculation',
              outputs: [{ label: 'Kill Mud Weight ppg', value: 10.37 }],
              formulas: ['KMW = OMW + SIDPP / (0.052 x TVD)'],
            },
          ],
          safety: {
            requires_human_verification: true,
            message: 'Verify safety-critical outputs with the competent person before action.',
          },
        },
        audit: {},
      },
    },
  ];

  it('renders verification banner, working panel (open), citation, and answer text', () => {
    const message = drive(events) as AssistantMessage;
    render(<Message message={message} />);

    // The DECISION SUPPORT verification banner appears as role="status".
    const verificationBanner = screen.getByRole('status');
    expect(verificationBanner).toHaveTextContent('DECISION SUPPORT ONLY');
    expect(verificationBanner).toHaveTextContent(
      /Verify with the competent person before action/,
    );

    // Working panel exists and is open by default on safety-critical results.
    const details = screen.getAllByText('Built kill sheet')[1]!.closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open');

    // Headline number is visible inside the working panel.
    expect(within(details as HTMLElement).getByText('Kill Mud Weight ppg')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('10.37')).toBeInTheDocument();

    // Working steps render as an ordered list inside the details element
    // (the raw JSON dump also contains the formula, so scope to the list).
    const stepsList = within(details as HTMLElement).getByRole('list');
    expect(within(stepsList).getByText(/KMW = OMW \+ SIDPP/)).toBeInTheDocument();

    // Citation pill is inline in the compact Sources footer (renders as a
    // span - non-url SOP citations don't link out).
    const sources = screen.getByRole('region', { name: /Sources/i });
    expect(within(sources).getByText(/Kick SOP/)).toBeInTheDocument();
    expect(within(sources).getByText('primary')).toBeInTheDocument();

    // Streamed answer text is visible.
    expect(
      screen.getByText(/Kill mud weight is 10\.37 ppg. Verify before pumping\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Kill sheet calculation')).toBeInTheDocument();
  });

  it('does not expose internal web-search tool names or queries', () => {
    const message = drive([
      {
        event: 'tool_call',
        data: { tool: 'web_search', id: 't1', input: { query: 'private search terms' } },
      },
      {
        event: 'tool_result',
        data: {
          tool: 'web_search',
          result: { results: [{ title: 'Source', url: 'https://example.com' }] },
        },
      },
      { event: 'token', data: { text: 'Here is the current source summary.' } },
      {
        event: 'done',
        data: {
          answer: 'Here is the current source summary.',
          tool_results: [
            {
              tool: 'web_search',
              input: { query: 'private search terms' },
              result: { results: [{ title: 'Source', url: 'https://example.com' }] },
            },
          ],
          flags: [],
          evidence_pack: {
            confidence: { label: 'Medium', reason: 'Some supporting evidence is present, with noted gaps.' },
            checked: ['1 source attached to the answer.'],
            not_verified: ['No uploaded SOP or procedure citation was used.'],
            sources: [{ type: 'web', label: 'Source', url: 'https://example.com' }],
            calculations: [],
            safety: { requires_human_verification: false, message: '' },
          },
          audit: {},
        },
      },
    ]) as AssistantMessage;

    render(<Message message={message} />);

    expect(screen.getAllByText(/Checked current sources|Searched the web/).length).toBeGreaterThan(0);
    expect(screen.queryByText('web_search')).not.toBeInTheDocument();
    expect(screen.queryByText(/query:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/private search terms/i)).not.toBeInTheDocument();
  });

  it('does not render an empty assistant bubble when a tool-backed turn finishes blank', () => {
    const message = drive([
      {
        event: 'tool_result',
        data: {
          tool: 'web_search',
          result: { results: [{ title: 'Source', url: 'https://example.com' }] },
        },
      },
      {
        event: 'done',
        data: {
          answer: '   ',
          tool_results: [
            {
              tool: 'web_search',
              input: { query: 'private search terms' },
              result: { results: [{ title: 'Source', url: 'https://example.com' }] },
            },
          ],
          flags: [],
          audit: {},
        },
      },
    ]) as AssistantMessage;

    render(<Message message={message} />);

    expect(screen.getByText(/response was interrupted/i)).toBeInTheDocument();
  });

  it('can read an assistant response aloud through the browser voice control', async () => {
    const user = userEvent.setup();
    const speak = vi.fn();
    const cancel = vi.fn();
    class MockSpeechSynthesisUtterance {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      volume = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak, cancel },
    });

    const message: AssistantMessage = {
      ...blankAssistant(),
      text: '## Safety\nConfirm the **pressure trend** before changing the [choke](https://example.com).',
      streaming: false,
    };

    render(<Message message={message} />);

    await user.click(screen.getByRole('button', { name: 'Read aloud' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.calls[0]?.[0]).toMatchObject({
      text: 'Safety Confirm the pressure trend before changing the choke.',
      rate: 1,
      pitch: 1,
      volume: 1,
    });
    expect(screen.getByRole('button', { name: 'Stop reading' })).toBeInTheDocument();
  });

  it('shows only the server-backed feedback buttons', () => {
    const message: AssistantMessage = {
      ...blankAssistant(),
      text: 'Use the approved operating envelope.',
      streaming: false,
      turnId: 'turn-1',
    };
    const onFeedback = vi.fn();

    render(<Message message={message} onFeedback={onFeedback} />);

    expect(screen.getAllByRole('button', { name: 'Good answer' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Bad answer' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Good response' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bad response' })).not.toBeInTheDocument();
  });

  it('renders a guardrail refusal banner when a safety_bypass flag arrives', () => {
    const refusal = drive([
      { event: 'flag', data: { flag: 'safety_bypass' } },
      { event: 'token', data: { text: "I can't help with bypassing a safety system." } },
      {
        event: 'done',
        data: {
          answer: "I can't help with bypassing a safety system.",
          tool_results: [],
          flags: ['safety_bypass'],
          audit: {},
        },
      },
    ]) as AssistantMessage;
    render(<Message message={refusal} />);
    // Banner (tone=danger) renders role="alert" with the refusal title.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/can't help with bypassing a safety system/);
    // The streamed answer text is also rendered in the body of the message.
    expect(
      screen.getAllByText(/can't help with bypassing a safety system/).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('speechTextFromMarkdown', () => {
  it('removes Markdown controls and raw URLs before speech', () => {
    expect(
      speechTextFromMarkdown(
        '# Heading\n- Read **this** [procedure](https://example.com) at https://example.com/raw.',
      ),
    ).toBe('Heading Read this procedure at');
  });
});

describe('Message - user prompt', () => {
  it('renders the user prompt with module + asset chips', () => {
    const message: MessageType = {
      id: 'u1',
      role: 'user',
      text: 'Build a kill sheet for OML-99 K-101.',
      module: 'well_control',
      assetContext: 'eq-1',
      createdAt: 0,
    };
    const { container } = render(<Message message={message} />);
    expect(within(container).getByText('Build a kill sheet for OML-99 K-101.')).toBeInTheDocument();
    expect(within(container).getByText('well_control')).toBeInTheDocument();
    expect(within(container).getByText(/asset: eq-1/)).toBeInTheDocument();
  });
});

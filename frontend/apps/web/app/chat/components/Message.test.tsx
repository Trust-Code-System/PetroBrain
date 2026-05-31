import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { applyEvent } from '../ChatClient';
import type { AssistantMessage, Message as MessageType } from '@/lib/chat/types';
import type { StreamEvent } from '@/lib/chat/streamChat';

import { Message } from './Message';

const ASSISTANT_ID = 'assistant-1';

function blankAssistant(): AssistantMessage {
  return {
    id: ASSISTANT_ID,
    role: 'assistant',
    text: '',
    citations: [],
    toolResults: [],
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
    { event: 'citation', data: { title: 'Kick SOP', revision: 'Rev 1', clause: '2.1' } },
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
        audit: {},
      },
    },
  ];

  it('renders verification banner, working panel (open), citation, and answer text', () => {
    const message = drive(events) as AssistantMessage;
    render(<Message message={message} />);

    // The DECISION SUPPORT verification banner appears as role="status"
    // (info-tone Banner). The same phrase also appears inside the raw-JSON
    // dump within the WorkingPanel, so scope the assertion to the banner.
    const verificationBanner = screen.getByRole('status');
    expect(verificationBanner).toHaveTextContent('DECISION SUPPORT ONLY');
    expect(verificationBanner).toHaveTextContent(
      /Verify with the competent person before action/,
    );

    // Working panel exists and is open by default on safety-critical results.
    const details = screen.getByText('build_kill_sheet').closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open');

    // Headline number is visible inside the working panel.
    expect(within(details as HTMLElement).getByText('kill_mud_weight_ppg')).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText('10.37')).toBeInTheDocument();

    // Working steps render as an ordered list inside the details element
    // (the raw JSON dump also contains the formula, so scope to the list).
    const stepsList = within(details as HTMLElement).getByRole('list');
    expect(within(stepsList).getByText(/KMW = OMW \+ SIDPP/)).toBeInTheDocument();

    // Citation pill is inline in the compact Sources footer (renders as a
    // span - non-url SOP citations don't link out).
    const sources = screen.getByRole('region', { name: /Sources/i });
    expect(within(sources).getByText(/Kick SOP/)).toBeInTheDocument();

    // Streamed answer text is visible.
    expect(
      screen.getByText(/Kill mud weight is 10\.37 ppg. Verify before pumping\./),
    ).toBeInTheDocument();
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

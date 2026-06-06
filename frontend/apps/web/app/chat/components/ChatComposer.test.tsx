import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './ChatComposer';

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }
}

afterEach(() => {
  MockSpeechRecognition.instances = [];
  Reflect.deleteProperty(window, 'webkitSpeechRecognition');
});

describe('ChatComposer voice input', () => {
  it('adds recognized speech to the prompt without exposing implementation labels', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: MockSpeechRecognition,
    });

    render(<ChatComposer onSubmit={vi.fn()} />);

    const voiceButton = await screen.findByRole('button', { name: 'Start voice input' });
    await user.click(voiceButton);

    const recognition = MockSpeechRecognition.instances[0]!;
    expect(recognition.start).toHaveBeenCalledTimes(1);

    act(() => {
      recognition.onresult?.({
        results: [
          { isFinal: true, 0: { transcript: 'Check pump pressure' } },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveValue('Check pump pressure');
    });
    expect(screen.queryByText(/SpeechRecognition|webkitSpeechRecognition|web speech/i)).not.toBeInTheDocument();
  });

  it('keeps the stop control usable while an assistant response is streaming', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();

    render(<ChatComposer onSubmit={vi.fn()} sending onStop={onStop} />);

    const stopButton = screen.getByRole('button', { name: 'Stop generating' });
    expect(stopButton).toBeEnabled();
    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

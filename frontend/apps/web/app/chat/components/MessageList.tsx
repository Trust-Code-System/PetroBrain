import type { FeedbackRating, Message as MessageType } from '@/lib/chat/types';

import { Message } from './Message';

export interface MessageListProps {
  messages: MessageType[];
  onRegenerate?: (assistantMessageId: string) => void;
  onOpenCanvas?: (assistantMessageId: string) => void;
  canvasMessageId?: string | null;
  onFeedback?: (assistantMessageId: string, rating: FeedbackRating, reason?: string | null) => void;
}

export function MessageList({
  messages, onRegenerate, onOpenCanvas, canvasMessageId, onFeedback,
}: MessageListProps) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-3 py-4 sm:gap-6 sm:p-6">
      {messages.map((m) => (
        <Message
          key={m.id}
          message={m}
          {...(onRegenerate ? { onRegenerate } : {})}
          {...(onOpenCanvas ? { onOpenCanvas } : {})}
          {...(canvasMessageId !== undefined ? { canvasMessageId } : {})}
          {...(onFeedback ? { onFeedback } : {})}
        />
      ))}
    </div>
  );
}

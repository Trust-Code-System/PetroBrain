import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { Message } from './types.js';

/**
 * One persisted conversation. ``ownerKey`` is ``${tenantId}:${userId}`` so
 * signing in as a different principal on the same browser doesn't leak
 * threads across users.
 */
export interface Conversation {
  id: string;
  ownerKey: string;
  title: string;
  messages: Message[];
  /** When non-null, this chat belongs to a project workspace. */
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ConversationsState {
  conversations: Record<string, Conversation>;
  order: string[];
  activeId: string | null;

  newConversation: (ownerKey: string, projectId?: string | null) => string;
  selectConversation: (id: string | null) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  setMessages: (
    id: string,
    messages: Message[],
    ownerKey: string,
    projectId?: string | null,
  ) => void;
  setTitleFromFirstMessage: (id: string, text: string) => void;
  setConversationProject: (id: string, projectId: string | null) => void;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `c-${Date.now()}-${counter}`;
}

function deriveTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 48) return cleaned || 'New chat';
  return `${cleaned.slice(0, 45)}…`;
}

export const useConversationsStore = create<ConversationsState>()(
  persist(
    (set, get) => ({
      conversations: {},
      order: [],
      activeId: null,

      newConversation: (ownerKey, projectId = null) => {
        const id = nextId();
        const now = Date.now();
        const convo: Conversation = {
          id,
          ownerKey,
          title: 'New chat',
          messages: [],
          projectId: projectId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          conversations: { ...s.conversations, [id]: convo },
          order: [id, ...s.order.filter((x) => x !== id)],
          activeId: id,
        }));
        return id;
      },

      selectConversation: (id) => set({ activeId: id }),

      deleteConversation: (id) => {
        set((s) => {
          const { [id]: _gone, ...rest } = s.conversations;
          const order = s.order.filter((x) => x !== id);
          const activeId = s.activeId === id ? order[0] ?? null : s.activeId;
          return { conversations: rest, order, activeId };
        });
      },

      renameConversation: (id, title) => {
        const clean = title.trim().slice(0, 80) || 'New chat';
        set((s) => {
          const existing = s.conversations[id];
          if (!existing) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...existing, title: clean, updatedAt: Date.now() },
            },
          };
        });
      },

      setMessages: (id, messages, ownerKey, projectId = null) => {
        set((s) => {
          const existing = s.conversations[id];
          const now = Date.now();
          if (!existing) {
            const convo: Conversation = {
              id,
              ownerKey,
              title: 'New chat',
              messages,
              projectId: projectId ?? null,
              createdAt: now,
              updatedAt: now,
            };
            return {
              conversations: { ...s.conversations, [id]: convo },
              order: [id, ...s.order.filter((x) => x !== id)],
            };
          }
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...existing, messages, updatedAt: now },
            },
            order: [id, ...s.order.filter((x) => x !== id)],
          };
        });
      },

      setTitleFromFirstMessage: (id, text) => {
        const convo = get().conversations[id];
        if (!convo) return;
        // Only auto-title if the user hasn't customized it.
        if (convo.title !== 'New chat') return;
        set((s) => ({
          conversations: {
            ...s.conversations,
            [id]: { ...convo, title: deriveTitle(text) },
          },
        }));
      },

      setConversationProject: (id, projectId) => {
        set((s) => {
          const existing = s.conversations[id];
          if (!existing) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...existing, projectId, updatedAt: Date.now() },
            },
          };
        });
      },
    }),
    {
      name: 'petrobrain-conversations',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          const stub: Storage = {
            length: 0,
            clear() {},
            getItem() { return null; },
            key() { return null; },
            removeItem() {},
            setItem() {},
          };
          return stub;
        }
        return window.localStorage;
      }),
      partialize: (s) => ({
        conversations: s.conversations,
        order: s.order,
        activeId: s.activeId,
      }),
    },
  ),
);

/**
 * Derive the principal-scoped owner key used to partition conversations.
 * Returns null if the user isn't signed in yet.
 */
export function ownerKeyOf(principal: { tenantId: string; userId: string } | null): string | null {
  if (!principal) return null;
  return `${principal.tenantId}:${principal.userId}`;
}

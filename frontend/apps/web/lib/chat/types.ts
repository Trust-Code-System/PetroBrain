import type { Citation, Module, ToolResult } from '@petrobrain/types';

export type MessageRole = 'user' | 'assistant';

/**
 * One on-screen turn. ``streaming=true`` means tokens are still arriving;
 * the renderer keeps the message visible and appends as events flow in.
 *
 * ``flags`` carries safety guardrail signals (``safety_bypass``,
 * ``unverified_numbers``, ``missing_safety_banner`` …). They drive the
 * top Banner; on safety-critical answers the Banner stays inline.
 */
/**
 * One file attached to a user turn. Images are kept as data URLs so they
 * survive a page reload (history lives in localStorage). Text-like files
 * (.txt, .md, .csv, .json) are inlined into the prompt at send time and
 * appear here as a transcript of what was sent. Other file types (.pdf,
 * .docx) are referenced by name only; they require backend ingestion via
 * the Documents tab to actually be searchable.
 */
export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'text' | 'document';
  /** For images: data URL. For text: the extracted text. For document: null. */
  preview: string | null;
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  module: Module;
  assetContext: string | null;
  attachments?: MessageAttachment[];
  createdAt: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  text: string;
  citations: Citation[];
  toolResults: ToolResult[];
  flags: string[];
  streaming: boolean;
  error?: string;
  createdAt: number;
}

export type Message = UserMessage | AssistantMessage;

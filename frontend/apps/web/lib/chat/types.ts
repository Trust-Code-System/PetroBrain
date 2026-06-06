import type { Citation, EvidencePack, Module, ToolResult } from '@petrobrain/types';

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
  requestedModule?: string;
  modulePinned?: boolean;
  routingNotice?: string | null;
  routingWarning?: boolean;
  routingConfidence?: string;
  routingReason?: string;
  assetContext: string | null;
  attachments?: MessageAttachment[];
  createdAt: number;
}

export type FeedbackRating = 'up' | 'down';

/** Local-first feedback state per assistant turn. Persisted alongside the
 *  message in localStorage so a refresh doesn't ask the user to re-rate.
 *  The server is the source of truth (POST /chat/feedback returns the row),
 *  but we render optimistically. */
export interface MessageFeedback {
  rating: FeedbackRating;
  reason?: string | null;
  sentAt: number;
}

export type WorkingStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface WorkingStep {
  id: string;
  label: string;
  status: WorkingStepStatus;
  detail?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgressSource {
  title: string;
  url?: string | null;
  domain?: string | null;
  reliability?: string | null;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  text: string;
  citations: Citation[];
  toolResults: ToolResult[];
  evidencePack: EvidencePack | null;
  flags: string[];
  workingSteps: WorkingStep[];
  progressSources: ProgressSource[];
  streaming: boolean;
  error?: string;
  createdAt: number;
  /** Server-minted turn id. Used as the key when posting feedback. May be
   *  missing on older messages persisted before this feature shipped. */
  turnId?: string;
  feedback?: MessageFeedback | null;
}

export type Message = UserMessage | AssistantMessage;

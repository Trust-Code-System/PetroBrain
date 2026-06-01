import type { Conversation } from './conversations';
import type { AssistantMessage, Message, UserMessage } from './types';

const ISO = (n: number) => new Date(n).toISOString();
const SAFE_FILENAME_RE = /[^a-z0-9-_]+/gi;

export function conversationToMarkdown(conv: Conversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push('');
  lines.push(`> Exported from PetroBrain - ${new Date().toISOString()}`);
  lines.push(`> Created: ${ISO(conv.createdAt)} - Updated: ${ISO(conv.updatedAt)}`);
  if (conv.messages.length === 0) {
    lines.push('');
    lines.push('_(empty conversation)_');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('---');
  for (const m of conv.messages) {
    lines.push('');
    if (m.role === 'user') {
      lines.push(...renderUser(m));
    } else {
      lines.push(...renderAssistant(m));
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    'PetroBrain is decision support - verify safety-critical numbers with the competent person before acting.',
  );
  return lines.join('\n');
}

function renderUser(m: UserMessage): string[] {
  const out: string[] = [`## You - ${ISO(m.createdAt)}`, ''];
  if (m.module && m.module !== 'general') {
    out.push(`_Module: ${m.module}${m.assetContext ? ` - Asset: ${m.assetContext}` : ''}_`);
    out.push('');
  } else if (m.assetContext) {
    out.push(`_Asset: ${m.assetContext}_`);
    out.push('');
  }
  if (m.text.trim()) {
    out.push(m.text.trim());
  }
  if (m.attachments && m.attachments.length > 0) {
    out.push('');
    out.push('**Attachments:**');
    for (const a of m.attachments) {
      out.push(`- ${a.name} (${a.kind}, ${formatBytes(a.sizeBytes)})`);
    }
  }
  return out;
}

function renderAssistant(m: AssistantMessage): string[] {
  const out: string[] = [`## PetroBrain - ${ISO(m.createdAt)}`, ''];
  if (m.error) {
    out.push(`> Error: ${m.error}`);
    out.push('');
  }
  if (m.text.trim()) {
    out.push(m.text.trim());
  }
  if (m.citations.length > 0) {
    out.push('');
    out.push('**Citations:**');
    for (const c of m.citations) {
      const parts = [c.title, c.revision, c.clause].filter(Boolean).join(' - ');
      out.push(`- ${parts}${c.url ? ` (${c.url})` : ''}`);
    }
  }
  if (m.flags.length > 0) {
    out.push('');
    out.push(`**Flags:** ${m.flags.join(', ')}`);
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function downloadMarkdown(filename: string, content: string): void {
  const safe = (filename.replace(SAFE_FILENAME_RE, '-').replace(/-+/g, '-').slice(0, 80) || 'conversation') + '.md';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportConversation(conv: Conversation): void {
  downloadMarkdown(conv.title, conversationToMarkdown(conv));
}

export function isExportable(messages: Message[]): boolean {
  return messages.length > 0 && messages.some((m) => m.text.trim().length > 0);
}

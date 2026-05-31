'use client';

import { useState, type FormEvent } from 'react';

import type { AssetNode } from '@petrobrain/types';
import { Badge, Button, Card, Input, Select } from '@petrobrain/ui';

import { DOCUMENT_TYPES, type PendingUpload, type DocumentType } from '@/lib/admin-documents/types';

import { AssetCombobox } from './AssetCombobox';

const DOCUMENT_TYPE_OPTIONS = DOCUMENT_TYPES.map((t) => ({ value: t, label: t }));

export interface PendingUploadCardProps {
  pending: PendingUpload;
  assets: AssetNode[];
  onChange: (next: PendingUpload) => void;
  onSubmit: (pending: PendingUpload) => void;
  onCancel: (pendingId: string) => void;
}

export function PendingUploadCard({
  pending,
  assets,
  onChange,
  onSubmit,
  onCancel,
}: PendingUploadCardProps) {
  const [touched, setTouched] = useState({ title: false, document_id: false });
  const titleError = touched.title && !pending.metadata.title.trim() ? 'Title is required.' : undefined;
  const docIdError = touched.document_id && !pending.metadata.document_id.trim()
    ? 'Document ID is required.'
    : undefined;

  function update(patch: Partial<PendingUpload['metadata']>) {
    onChange({ ...pending, metadata: { ...pending.metadata, ...patch } });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ title: true, document_id: true });
    if (!pending.metadata.title.trim() || !pending.metadata.document_id.trim()) return;
    onSubmit(pending);
  }

  return (
    <Card
      title={pending.file.name}
      description={`${formatBytes(pending.file.size)} · ${pending.file.type || 'unknown type'}`}
    >
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            label="Title"
            value={pending.metadata.title}
            onChange={(e) => update({ title: e.target.value })}
            onBlur={() => setTouched((t) => ({ ...t, title: true }))}
            {...(titleError ? { error: titleError } : {})}
            disabled={pending.submitting}
          />
          <Input
            label="Document ID"
            placeholder="SOP-KICK-001"
            value={pending.metadata.document_id}
            onChange={(e) => update({ document_id: e.target.value })}
            onBlur={() => setTouched((t) => ({ ...t, document_id: true }))}
            {...(docIdError ? { error: docIdError } : {})}
            hint="Stable id used to dedupe revisions."
            disabled={pending.submitting}
          />
          <Input
            label="Revision"
            placeholder="Rev 1"
            value={pending.metadata.revision}
            onChange={(e) => update({ revision: e.target.value })}
            disabled={pending.submitting}
          />
          <Input
            label="Jurisdiction"
            placeholder="Nigeria"
            value={pending.metadata.jurisdiction}
            onChange={(e) => update({ jurisdiction: e.target.value })}
            disabled={pending.submitting}
          />
          <Select
            label="Document type"
            value={pending.metadata.document_type}
            onChange={(e) => update({ document_type: e.target.value as DocumentType })}
            options={DOCUMENT_TYPE_OPTIONS}
            disabled={pending.submitting}
          />
          <Input
            label="Effective date"
            type="date"
            value={pending.metadata.effective_date ?? ''}
            onChange={(e) => update({ effective_date: e.target.value || null })}
            disabled={pending.submitting}
          />
        </div>
        <AssetCombobox
          label="Asset"
          value={pending.metadata.asset}
          onChange={(asset) => update({ asset })}
          assets={assets}
          hint="Optional. Used to filter retrieved citations to this facility."
          disabled={pending.submitting}
        />
        {pending.error ? (
          <p role="alert" className="text-sm text-danger-fg dark:text-danger-bg">
            {pending.error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={pending.submitting ? 'info' : 'neutral'}>
              {pending.submitting ? 'uploading…' : 'pending'}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onCancel(pending.pendingId)}
              disabled={pending.submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending.submitting} loading={pending.submitting}>
              Upload
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

'use client';

import { useDropzone } from 'react-dropzone';
import clsx from 'clsx';

const ACCEPT = {
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

export interface DropzoneProps {
  onFilesDropped: (files: File[]) => void;
  disabled?: boolean;
}

/**
 * Drag-and-drop landing surface. Accepts the extensions the A5 worker
 * knows how to extract (.txt, .md, .markdown, .pdf, .docx). Browser
 * upload picker fallback is included for users on touch / corp-locked
 * machines where drag-and-drop is awkward.
 */
export function Dropzone({ onFilesDropped, disabled }: DropzoneProps) {
  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    accept: ACCEPT,
    multiple: true,
    disabled: disabled ?? false,
    onDrop: (files) => {
      if (files.length > 0) onFilesDropped(files);
    },
  });

  return (
    <div
      {...getRootProps({
        className: clsx(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400',
          isDragReject
            ? 'border-danger-border bg-danger-bg text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg'
            : isDragActive
              ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500 dark:bg-primary-900/30 dark:text-primary-200'
              : 'border-neutral-300 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300',
          disabled && 'cursor-not-allowed opacity-60',
        ),
      })}
    >
      <input {...getInputProps()} />
      <p className="text-sm font-medium">
        {isDragActive
          ? 'Drop the files to start composing the upload metadata.'
          : 'Drop documents here, or click to browse.'}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Accepted: .txt · .md · .markdown · .pdf · .docx. Each file gets its own metadata form.
      </p>
    </div>
  );
}

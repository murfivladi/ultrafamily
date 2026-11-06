'use client';

import type { FilePreview } from '@ufos/contracts';
import { useApp } from './app-provider';

export function FilePreviewView({ preview, name }: { preview: FilePreview | null; name: string }) {
  const { t } = useApp();
  if (!preview) return <div className="uf-skeleton h-40" />;
  const box =
    'w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-soft)]';
  if (preview.mode === 'image' && preview.contentUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preview.contentUrl} alt={name} className={`${box} max-h-96 object-contain`} />;
  }
  if (preview.mode === 'video' && preview.contentUrl) {
    return (
      <video src={preview.contentUrl} controls preload="metadata" className={`${box} max-h-96`} />
    );
  }
  if (preview.mode === 'audio' && preview.contentUrl) {
    return <audio src={preview.contentUrl} controls className="w-full" />;
  }
  if (preview.mode === 'pdf' && preview.contentUrl) {
    return (
      <iframe
        src={preview.contentUrl}
        title={name}
        className={`${box} h-96`}
        sandbox="allow-same-origin"
      />
    );
  }
  if (preview.mode === 'text' && preview.text !== null) {
    return (
      <pre className={`${box} uf-mono max-h-96 whitespace-pre-wrap break-words p-3 text-xs`}>
        {preview.text}
        {preview.truncated ? '\n…' : ''}
      </pre>
    );
  }
  if (preview.mode === 'archive') return null;
  return <p className="text-sm text-[var(--muted)]">{t('stageD.files.noPreview')}</p>;
}

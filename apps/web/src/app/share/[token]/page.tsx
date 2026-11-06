'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import * as Lucide from 'lucide-react';
import type { PublicShareView } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import { Badge, Brand, Button, Card, Field, LanguageSelect } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';

/**
 * Public view of a protected share link. No session is used; access is the
 * unguessable token, optionally a password (short-lived grant), an expiry and
 * revocation. When downloads are disabled media is only shown inline.
 */
export default function SharePage() {
  const params = useParams<{ token: string }>();
  const { t, language, selectLanguage } = useApp();
  const [view, setView] = useState<PublicShareView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'gone' | 'error'>('loading');
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [busy, setBusy] = useState(false);
  const token = encodeURIComponent(params.token);

  const load = useCallback(async () => {
    try {
      setView(await apiFetch<PublicShareView>(`/public/shares/${token}`));
      setStatus('ready');
    } catch (error) {
      setStatus(
        error instanceof ApiError && (error.status === 410 || error.status === 404)
          ? 'gone'
          : 'error',
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setUnlockError('');
    try {
      setView(
        await apiFetch<PublicShareView>(`/public/shares/${token}/unlock`, {
          method: 'POST',
          body: { password },
        }),
      );
      setPassword('');
    } catch (error) {
      setUnlockError(
        error instanceof ApiError && error.message === 'share_unlock_throttled'
          ? t('stageD.share.throttled')
          : t('stageD.share.wrongPassword'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="mx-auto min-h-screen max-w-5xl px-4 py-8"
      onContextMenu={view && !view.allowDownload ? (event) => event.preventDefault() : undefined}
    >
      {/* Share links are private: never index them (React hoists this into <head>). */}
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="mb-8 flex items-center justify-between">
        <Brand />
        <LanguageSelect
          value={language}
          onChange={(next) => void selectLanguage(next)}
          ariaLabel={t('common.language')}
        />
      </header>
      {status === 'loading' ? (
        <div className="uf-skeleton h-72" />
      ) : status === 'gone' ? (
        <Card className="p-8 text-center">
          <Lucide.Unlink className="mx-auto mb-3 h-8 w-8 text-[var(--muted)]" aria-hidden="true" />
          <h1 className="text-xl font-bold">{t('stageD.share.gone')}</h1>
        </Card>
      ) : status === 'error' || !view ? (
        <Card className="p-8 text-center">{t('common.error')}</Card>
      ) : view.passwordRequired ? (
        <Card className="mx-auto max-w-sm p-6">
          <h1 className="mb-4 flex items-center gap-2 text-lg font-bold">
            <Lucide.Lock className="h-5 w-5" aria-hidden="true" />
            {t('stageD.share.protected')}
          </h1>
          <form onSubmit={unlock} className="space-y-3">
            <Field label={t('stageD.share.password')} htmlFor="share-password">
              <input
                id="share-password"
                type="password"
                autoComplete="off"
                className="uf-input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            {unlockError ? (
              <p role="alert" className="text-sm text-rose-600">
                {unlockError}
              </p>
            ) : null}
            <Button type="submit" variant="primary" loading={busy}>
              {t('stageD.share.open')}
            </Button>
          </form>
        </Card>
      ) : (
        <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-black">{view.label || t('stageD.share.shared')}</h1>
            <Badge>
              {t('stageD.share.until', { date: new Date(view.expiresAt).toLocaleString() })}
            </Badge>
            {!view.allowDownload ? (
              <Badge tone="warning">{t('stageD.share.noDownload')}</Badge>
            ) : null}
          </div>
          {view.items.length === 0 ? (
            <Card className="p-8 text-center">{t('stageD.photos.empty')}</Card>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {view.items.map((item) => (
                <li key={item.id}>
                  <Card className="overflow-hidden">
                    {item.kind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.contentUrl}
                        alt={item.name}
                        draggable={view.allowDownload}
                        className="aspect-square w-full object-cover"
                      />
                    ) : item.kind === 'video' ? (
                      <video
                        src={item.contentUrl}
                        controls
                        controlsList={view.allowDownload ? undefined : 'nodownload'}
                        className="w-full"
                      />
                    ) : item.kind === 'audio' ? (
                      <audio src={item.contentUrl} controls className="w-full" />
                    ) : null}
                    <div className="flex items-center justify-between gap-2 p-2 text-xs">
                      <span className="truncate">{item.name}</span>
                      {view.allowDownload ? (
                        <a
                          className="uf-link"
                          href={`${item.contentUrl}${item.contentUrl.includes('?') ? '&' : '?'}download=1`}
                        >
                          <Lucide.Download
                            className="h-4 w-4"
                            aria-label={t('stageD.files.download')}
                          />
                        </a>
                      ) : null}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-6 text-xs text-[var(--muted)]">{t('stageD.share.footer')}</p>
        </section>
      )}
    </main>
  );
}

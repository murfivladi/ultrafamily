'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as Lucide from 'lucide-react';
import type { PublicPost } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import { Badge, Brand, Card, LanguageSelect } from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/i18n';
import { formatDate } from '@/lib/format';

export default function PublicPostPage() {
  const params = useParams<{ slug: string }>();
  const { language, t, selectLanguage } = useApp();
  const [post, setPost] = useState<PublicPost | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorCode, setErrorCode] = useState<number>(500);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void apiFetch<PublicPost>(`/public/posts/${encodeURIComponent(params.slug)}`)
      .then((data) => {
        if (!cancelled) {
          setPost(data);
          setStatus('ready');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorCode(
            error instanceof Error && 'status' in error ? Number(error.status) || 500 : 500,
          );
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params.slug]);

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-6">
        <Link href="/" aria-label="Ultra Family OS">
          <Brand />
        </Link>
        <LanguageSelect
          value={language}
          onChange={(next) => void selectLanguage(next)}
          ariaLabel={t('common.language')}
        />
      </header>
      <main id="main-content" className="mx-auto max-w-3xl px-5 pb-16">
        <Link href="/" className="uf-link mb-7 inline-flex items-center gap-2 text-sm">
          <Lucide.ArrowLeft className="h-4 w-4" />
          {t('common.backToSite')}
        </Link>
        {status === 'loading' ? (
          <div className="space-y-4">
            <div className="uf-skeleton h-8 w-2/3" />
            <div className="uf-skeleton h-5 w-1/3" />
            <div className="uf-skeleton h-64" />
          </div>
        ) : status === 'error' || !post ? (
          <Card className="p-10 text-center">
            <Lucide.FileQuestion className="mx-auto h-10 w-10 text-[var(--muted)]" />
            <h1 className="mt-4 text-xl font-bold">{errorMessage(language, errorCode)}</h1>
          </Card>
        ) : (
          <article>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="success">{post.spaceName}</Badge>
              <span className="text-xs text-[var(--muted)]">
                {t('public.published', { date: formatDate(language, post.publishedAt) })}
              </span>
            </div>
            <h1 className="mt-5 text-4xl font-black tracking-tight md:text-5xl">{post.title}</h1>
            <p className="mt-4 text-lg leading-8 text-[var(--muted)]">{post.excerpt}</p>
            <Card className="mt-8 p-7 md:p-10">
              <div className="space-y-5 text-base leading-8">
                {post.body.split(/\n+/).map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </Card>
            <p className="mt-6 flex items-center gap-2 text-xs text-[var(--muted)]">
              <Lucide.ShieldCheck className="h-4 w-4" />
              {t('common.privacyNote')}
            </p>
          </article>
        )}
      </main>
    </div>
  );
}

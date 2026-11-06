'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { MemoryCollection, MemoryItem, MemoryYear } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Card, EmptyState, ErrorPanel, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { contentUrl } from '@/lib/uploads';
import { useRealtimeReload } from '@/lib/use-realtime';

const KIND_ICON: Record<MemoryItem['kind'], keyof typeof Lucide> = {
  journal: 'NotebookPen',
  story: 'BookOpen',
  photo: 'Image',
  video: 'Film',
  audio: 'Music',
  birth: 'Cake',
  event: 'CalendarDays',
};

function MemoryCard({ item, spaceId }: { item: MemoryItem; spaceId: string }) {
  const { t } = useApp();
  const IconComponent = Lucide[KIND_ICON[item.kind]] as Lucide.LucideIcon;
  return (
    <Link href={item.href} className="block">
      <Card className="h-full overflow-hidden transition hover:-translate-y-0.5">
        {item.kind === 'photo' && item.fileId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={contentUrl(spaceId, item.fileId)}
            alt={item.title}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        ) : null}
        <div className="p-3">
          <p className="flex items-center gap-1 text-xs text-[var(--muted)]">
            <IconComponent className="h-3.5 w-3.5" aria-hidden="true" />
            {t(`stageD.memories.kind.${item.kind}`)} · {item.date}
          </p>
          <p className="mt-1 font-bold">{item.title}</p>
          {item.summary ? (
            <p className="mt-1 line-clamp-3 text-sm text-[var(--muted)]">{item.summary}</p>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}

export default function MemoriesPage() {
  const { t, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { reload, refresh } = useRealtimeReload(spaceId, ['journal', 'photos']);
  const [collections, setCollections] = useState<MemoryCollection[]>([]);
  const [years, setYears] = useState<MemoryYear[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) return;
    setError(false);
    try {
      const today = new Date();
      const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const [sets, timeline] = await Promise.all([
        apiFetch<MemoryCollection[]>(apiPath('/memories/collections', { spaceId, date: local })),
        apiFetch<MemoryYear[]>(apiPath('/memories/timeline', { spaceId, year: year ?? undefined })),
      ]);
      setCollections(sets);
      setYears(timeline);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId, year]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const collectionTitle = (collection: MemoryCollection) =>
    collection.kind === 'album'
      ? collection.title
      : t(`stageD.memories.collection.${collection.kind}`);

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.memories')}
        description={t('stageD.memories.subtitle')}
      />
      {!spaceId ? (
        <EmptyState icon="UsersRound" title={t('common.noData')} />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="uf-skeleton h-96" />
      ) : (
        <div className="space-y-8">
          {collections.map((collection) => (
            <section key={collection.id} aria-labelledby={`collection-${collection.id}`}>
              <h2
                id={`collection-${collection.id}`}
                className="mb-3 flex items-center gap-2 text-xl font-black"
              >
                <Lucide.Sparkles className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
                {collectionTitle(collection)}
                {collection.kind === 'last_month' || collection.kind === 'on_this_day' ? (
                  <Badge>{collection.description}</Badge>
                ) : null}
              </h2>
              {collection.items.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageD.memories.nothingToday')}</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {collection.items.slice(0, 8).map((item) => (
                    <li key={`${collection.id}-${item.kind}-${item.id}`}>
                      <MemoryCard item={item} spaceId={spaceId} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          <section aria-labelledby="timeline-heading">
            <h2 id="timeline-heading" className="mb-3 text-xl font-black">
              {t('stageD.memories.timeline')}
            </h2>
            <div className="uf-pill-row mb-4">
              <button
                type="button"
                className={`uf-button ${year === null ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                onClick={() => setYear(null)}
              >
                {t('common.all')}
              </button>
              {years.map((entry) => (
                <button
                  key={entry.year}
                  type="button"
                  className={`uf-button ${year === entry.year ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                  onClick={() => setYear(entry.year)}
                >
                  {entry.year} · {entry.count}
                </button>
              ))}
            </div>
            {years.length === 0 ? (
              <EmptyState icon="Sparkles" title={t('stageD.memories.empty')} />
            ) : (
              <ol className="space-y-6 border-l-2 border-[var(--border)] pl-5">
                {years.map((entry) => (
                  <li key={entry.year}>
                    <h3 className="-ml-[1.95rem] mb-2 flex items-center gap-2 text-lg font-bold">
                      <span
                        className="inline-block h-3 w-3 rounded-full bg-[var(--accent)]"
                        aria-hidden="true"
                      />
                      {entry.year}
                    </h3>
                    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {entry.items.map((item) => (
                        <li key={`${entry.year}-${item.kind}-${item.id}`}>
                          <MemoryCard item={item} spaceId={spaceId} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </>
  );
}

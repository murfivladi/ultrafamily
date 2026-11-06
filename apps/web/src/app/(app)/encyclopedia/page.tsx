'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { FamilyPerson, FamilyPersonDetail, FamilyTree, RelationKind } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { describeError } from '@/lib/uploads';
import { useRealtimeReload } from '@/lib/use-realtime';

interface PersonForm {
  fullName: string;
  birthName: string;
  birthDate: string;
  deathDate: string;
  birthPlace: string;
  biography: string;
  phone: string;
  email: string;
  address: string;
  contactVisibility: 'owner' | 'adults' | 'family';
  visibility: 'private' | 'family';
}

const blankForm = (): PersonForm => ({
  fullName: '',
  birthName: '',
  birthDate: '',
  deathDate: '',
  birthPlace: '',
  biography: '',
  phone: '',
  email: '',
  address: '',
  contactVisibility: 'adults',
  visibility: 'family',
});

const years = (person: FamilyPerson) => {
  const birth = person.birthDate?.slice(0, 4) ?? '?';
  return person.deathDate
    ? `${birth}–${person.deathDate.slice(0, 4)}`
    : person.birthDate
      ? `${birth}`
      : '';
};

export default function EncyclopediaPage() {
  const { t, notify, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const permissions = useMemo(() => new Set(snapshot?.permissions ?? []), [snapshot?.permissions]);
  const canCreate = permissions.has('encyclopedia:create');
  const canPublish = permissions.has('encyclopedia:publish');
  const { reload, refresh } = useRealtimeReload(spaceId, ['encyclopedia']);
  const [tree, setTree] = useState<FamilyTree | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<FamilyPersonDetail | null>(null);
  const [form, setForm] = useState<PersonForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [relation, setRelation] = useState<{
    other: string;
    kind: RelationKind;
    direction: 'parentOf' | 'childOf' | 'with';
  }>({
    other: '',
    kind: 'parent',
    direction: 'parentOf',
  });
  const [consentNote, setConsentNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) return;
    setError(false);
    try {
      setTree(await apiFetch<FamilyTree>(apiPath('/encyclopedia/tree', { spaceId })));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const person = new URLSearchParams(window.location.search).get('person');
    if (person) setSelectedId(person);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!spaceId || !selectedId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(
        await apiFetch<FamilyPersonDetail>(
          apiPath(`/encyclopedia/people/${encodeURIComponent(selectedId)}`, { spaceId }),
        ),
      );
    } catch {
      setDetail(null);
    }
  }, [selectedId, spaceId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, reload]);

  const generations = useMemo(() => {
    const map = new Map<number, Array<FamilyTree['people'][number]>>();
    for (const person of tree?.people ?? []) {
      map.set(person.generation, [...(map.get(person.generation) ?? []), person]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [tree]);

  const spouseOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const relationEntry of tree?.relations ?? []) {
      if (relationEntry.kind !== 'spouse') continue;
      map.set(relationEntry.personId, [
        ...(map.get(relationEntry.personId) ?? []),
        relationEntry.relatedPersonId,
      ]);
      map.set(relationEntry.relatedPersonId, [
        ...(map.get(relationEntry.relatedPersonId) ?? []),
        relationEntry.personId,
      ]);
    }
    return map;
  }, [tree]);

  const nameOf = (id: string) => tree?.people.find((person) => person.id === id)?.fullName ?? '—';

  const act = async (action: () => Promise<unknown>, success = t('common.saved')) => {
    try {
      await action();
      notify(success, 'success');
      await Promise.all([load(), loadDetail()]);
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    }
  };

  const submitPerson = (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !form) return;
    const body = {
      spaceId,
      fullName: form.fullName.trim(),
      birthName: form.birthName.trim(),
      birthDate: form.birthDate || null,
      deathDate: form.deathDate || null,
      birthPlace: form.birthPlace.trim(),
      biography: form.biography,
      contacts: {
        ...(form.phone ? { phone: form.phone } : {}),
        ...(form.email ? { email: form.email } : {}),
        ...(form.address ? { address: form.address } : {}),
      },
      contactVisibility: form.contactVisibility,
      visibility: form.visibility,
    };
    void act(async () => {
      const saved = editingId
        ? await apiFetch<FamilyPerson>(`/encyclopedia/people/${encodeURIComponent(editingId)}`, {
            method: 'PATCH',
            body,
          })
        : await apiFetch<FamilyPerson>('/encyclopedia/people', { method: 'POST', body });
      setForm(null);
      setEditingId(null);
      setSelectedId(saved.id);
    });
  };

  const addRelation = (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !detail || !relation.other) return;
    const kind: RelationKind = relation.direction === 'with' ? relation.kind : 'parent';
    const [personId, relatedPersonId] =
      relation.direction === 'childOf' ? [relation.other, detail.id] : [detail.id, relation.other];
    void act(() =>
      apiFetch('/encyclopedia/relations', {
        method: 'POST',
        body: { spaceId, personId, relatedPersonId, kind },
      }),
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.encyclopedia')}
        description={t('stageD.encyclopedia.subtitle')}
        action={
          canCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setForm(blankForm());
                setEditingId(null);
              }}
            >
              <Lucide.UserPlus className="h-4 w-4" aria-hidden="true" />
              {t('stageD.encyclopedia.add')}
            </Button>
          ) : null
        }
      />
      {!spaceId ? (
        <EmptyState icon="UsersRound" title={t('common.noData')} />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading || !tree ? (
        <div className="uf-skeleton h-96" />
      ) : (
        <div className="uf-split uf-split-main">
          <section aria-labelledby="tree-heading" className="space-y-4">
            <h2 id="tree-heading" className="sr-only">
              {t('stageD.encyclopedia.tree')}
            </h2>
            {tree.people.length === 0 ? (
              <EmptyState icon="Network" title={t('stageD.encyclopedia.empty')} />
            ) : (
              <Card className="overflow-x-auto p-4">
                <ol className="space-y-6">
                  {generations.map(([generation, people]) => (
                    <li key={generation}>
                      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                        {t('stageD.encyclopedia.generation', { n: generation + 1 })}
                      </p>
                      <ul className="flex flex-wrap gap-3">
                        {people.map((person) => (
                          <li key={person.id} className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setSelectedId(person.id)}
                              aria-current={selectedId === person.id ? 'true' : undefined}
                              className={`min-w-[10rem] rounded-2xl border p-3 text-left text-sm transition ${
                                selectedId === person.id
                                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                                  : 'border-[var(--border)] hover:border-[var(--accent)]'
                              }`}
                            >
                              <span className="flex items-center gap-1 font-bold">
                                {person.visibility === 'private' ? (
                                  <Lucide.Lock
                                    className="h-3.5 w-3.5"
                                    aria-label={t('stageD.private')}
                                  />
                                ) : null}
                                {person.fullName}
                              </span>
                              <span className="block text-xs text-[var(--muted)]">
                                {years(person)} {person.living ? '' : '✝'}
                              </span>
                            </button>
                            {(spouseOf.get(person.id) ?? []).some((other) =>
                              people.some((entry) => entry.id === other),
                            ) ? (
                              <Lucide.Heart
                                className="h-3.5 w-3.5 text-rose-400"
                                aria-label={t('stageD.encyclopedia.spouse')}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {form ? (
              <Card className="p-5">
                <form onSubmit={submitPerson} className="grid gap-3 md:grid-cols-2">
                  <Field
                    label={t('stageD.encyclopedia.fullName')}
                    htmlFor="person-name"
                    className="md:col-span-2"
                  >
                    <input
                      id="person-name"
                      className="uf-input"
                      required
                      value={form.fullName}
                      onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.encyclopedia.birthName')} htmlFor="person-birthname">
                    <input
                      id="person-birthname"
                      className="uf-input"
                      value={form.birthName}
                      onChange={(e) => setForm({ ...form, birthName: e.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.encyclopedia.birthPlace')} htmlFor="person-place">
                    <input
                      id="person-place"
                      className="uf-input"
                      value={form.birthPlace}
                      onChange={(e) => setForm({ ...form, birthPlace: e.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.encyclopedia.birthDate')} htmlFor="person-birth">
                    <input
                      id="person-birth"
                      type="date"
                      className="uf-input"
                      value={form.birthDate}
                      onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.encyclopedia.deathDate')} htmlFor="person-death">
                    <input
                      id="person-death"
                      type="date"
                      className="uf-input"
                      value={form.deathDate}
                      onChange={(e) => setForm({ ...form, deathDate: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('stageD.encyclopedia.biography')}
                    htmlFor="person-bio"
                    className="md:col-span-2"
                  >
                    <textarea
                      id="person-bio"
                      className="uf-textarea"
                      rows={5}
                      value={form.biography}
                      onChange={(e) => setForm({ ...form, biography: e.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.encyclopedia.phone')} htmlFor="person-phone">
                    <input
                      id="person-phone"
                      className="uf-input"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="Email" htmlFor="person-email">
                    <input
                      id="person-email"
                      type="email"
                      className="uf-input"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('stageD.encyclopedia.address')}
                    htmlFor="person-address"
                    className="md:col-span-2"
                  >
                    <input
                      id="person-address"
                      className="uf-input"
                      value={form.address}
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('stageD.encyclopedia.contactVisibility')}
                    htmlFor="person-contact-visibility"
                  >
                    <select
                      id="person-contact-visibility"
                      className="uf-select"
                      value={form.contactVisibility}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          contactVisibility: e.target.value as PersonForm['contactVisibility'],
                        })
                      }
                    >
                      {(['owner', 'adults', 'family'] as const).map((value) => (
                        <option key={value} value={value}>
                          {t(`stageD.encyclopedia.contacts.${value}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('stageD.journal.visibility')} htmlFor="person-visibility">
                    <select
                      id="person-visibility"
                      className="uf-select"
                      value={form.visibility}
                      onChange={(e) =>
                        setForm({ ...form, visibility: e.target.value as PersonForm['visibility'] })
                      }
                    >
                      <option value="family">{t('stageD.journal.family')}</option>
                      <option value="private">{t('stageD.encyclopedia.privateEntry')}</option>
                    </select>
                  </Field>
                  <div className="uf-pill-row md:col-span-2">
                    <Button type="submit" variant="primary">
                      {t('common.save')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </form>
              </Card>
            ) : null}
          </section>

          <aside>
            {!detail ? (
              <EmptyState
                icon="UserRound"
                title={t('stageD.encyclopedia.pick')}
                description={t('stageD.encyclopedia.privacy')}
              />
            ) : (
              <Card className="space-y-4 p-5">
                <header>
                  <h2 className="text-xl font-black">{detail.fullName}</h2>
                  <p className="text-sm text-[var(--muted)]">
                    {detail.birthDate ?? '?'}
                    {detail.deathDate ? ` – ${detail.deathDate}` : ''}
                    {detail.birthPlace ? ` · ${detail.birthPlace}` : ''}
                  </p>
                  <div className="uf-pill-row mt-2">
                    <Badge tone={detail.living ? 'success' : 'default'}>
                      {detail.living
                        ? t('stageD.encyclopedia.living')
                        : t('stageD.encyclopedia.deceased')}
                    </Badge>
                    {detail.publishAllowed ? (
                      <Badge tone="accent">{t('stageD.encyclopedia.published')}</Badge>
                    ) : null}
                    {detail.visibility === 'private' ? (
                      <Badge tone="warning">{t('stageD.encyclopedia.privateEntry')}</Badge>
                    ) : null}
                  </div>
                </header>
                {detail.biography ? (
                  <p className="whitespace-pre-wrap text-sm leading-6">{detail.biography}</p>
                ) : null}
                <section>
                  <h3 className="mb-1 text-sm font-bold">
                    {t('stageD.encyclopedia.contactsTitle')}
                  </h3>
                  {detail.contacts && Object.keys(detail.contacts).length > 0 ? (
                    <ul className="text-sm">
                      {Object.entries(detail.contacts).map(([key, value]) => (
                        <li key={key}>
                          {t(`stageD.encyclopedia.${key === 'email' ? 'emailLabel' : key}`)}:{' '}
                          {value}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[var(--muted)]">
                      {detail.contactsHidden ? t('stageD.encyclopedia.contactsHidden') : '—'}
                    </p>
                  )}
                </section>
                <section>
                  <h3 className="mb-1 text-sm font-bold">{t('stageD.encyclopedia.relations')}</h3>
                  <ul className="space-y-1 text-sm">
                    {detail.relations.map((entry) => (
                      <li key={entry.id} className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="uf-link"
                          onClick={() =>
                            setSelectedId(
                              entry.direction === 'out' ? entry.relatedPersonId : entry.personId,
                            )
                          }
                        >
                          {t(`stageD.encyclopedia.rel.${entry.kind}.${entry.direction}`)}:{' '}
                          {entry.otherName}
                        </button>
                        {canCreate ? (
                          <button
                            type="button"
                            className="text-[var(--muted)] hover:text-rose-600"
                            aria-label={t('stageC.messenger.delete')}
                            onClick={() =>
                              void act(() =>
                                apiFetch(
                                  apiPath(
                                    `/encyclopedia/relations/${encodeURIComponent(entry.id)}`,
                                    { spaceId },
                                  ),
                                  {
                                    method: 'DELETE',
                                  },
                                ),
                              )
                            }
                          >
                            <Lucide.X className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {canCreate ? (
                    <form onSubmit={addRelation} className="mt-2 flex flex-wrap items-end gap-2">
                      <select
                        className="uf-select w-36 text-xs"
                        aria-label={t('stageD.encyclopedia.relationType')}
                        value={relation.direction === 'with' ? relation.kind : relation.direction}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === 'parentOf' || value === 'childOf')
                            setRelation({ ...relation, direction: value, kind: 'parent' });
                          else
                            setRelation({
                              ...relation,
                              direction: 'with',
                              kind: value as RelationKind,
                            });
                        }}
                      >
                        <option value="parentOf">{t('stageD.encyclopedia.rel.parent.out')}</option>
                        <option value="childOf">{t('stageD.encyclopedia.rel.parent.in')}</option>
                        <option value="spouse">{t('stageD.encyclopedia.rel.spouse.out')}</option>
                        <option value="sibling">{t('stageD.encyclopedia.rel.sibling.out')}</option>
                      </select>
                      <select
                        className="uf-select w-40 text-xs"
                        aria-label={t('stageD.encyclopedia.relative')}
                        value={relation.other}
                        onChange={(event) =>
                          setRelation({ ...relation, other: event.target.value })
                        }
                      >
                        <option value="">{t('stageD.encyclopedia.relative')}</option>
                        {tree.people
                          .filter((person) => person.id !== detail.id)
                          .map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.fullName}
                            </option>
                          ))}
                      </select>
                      <Button type="submit" className="text-xs" disabled={!relation.other}>
                        {t('common.create')}
                      </Button>
                    </form>
                  ) : null}
                </section>
                {detail.links.length > 0 ? (
                  <section>
                    <h3 className="mb-1 text-sm font-bold">{t('stageD.encyclopedia.links')}</h3>
                    <ul className="space-y-1 text-sm">
                      {detail.links.map((link) => (
                        <li key={`${link.targetKind}-${link.targetId}`}>
                          <Link
                            className="uf-link"
                            href={
                              link.targetKind === 'journal'
                                ? `/journal?entry=${link.targetId}`
                                : link.targetKind === 'file'
                                  ? `/files?file=${link.targetId}`
                                  : link.targetKind === 'document'
                                    ? `/documents?id=${link.targetId}`
                                    : `/photos`
                            }
                          >
                            {t(`stageD.encyclopedia.link.${link.targetKind}`)}: {link.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {detail.photos.length > 0 ? (
                  <section>
                    <h3 className="mb-1 text-sm font-bold">{t('modules.photos')}</h3>
                    <ul className="grid grid-cols-3 gap-2">
                      {detail.photos.map((photo) => (
                        <li key={photo.id}>
                          <Link href={`/photos?item=${photo.id}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/files/${encodeURIComponent(photo.id)}/content?spaceId=${encodeURIComponent(spaceId)}`}
                              alt={photo.name}
                              className="aspect-square w-full rounded-lg object-cover"
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                <div className="uf-pill-row border-t border-[var(--border)] pt-3">
                  {canCreate ? (
                    <Button
                      onClick={() => {
                        setEditingId(detail.id);
                        setForm({
                          fullName: detail.fullName,
                          birthName: detail.birthName,
                          birthDate: detail.birthDate ?? '',
                          deathDate: detail.deathDate ?? '',
                          birthPlace: detail.birthPlace,
                          biography: detail.biography,
                          phone: detail.contacts?.phone ?? '',
                          email: detail.contacts?.email ?? '',
                          address: detail.contacts?.address ?? '',
                          contactVisibility: detail.contactVisibility,
                          visibility: detail.visibility,
                        });
                      }}
                    >
                      <Lucide.Pencil className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.messenger.edit')}
                    </Button>
                  ) : null}
                </div>
                {canPublish ? (
                  <section className="space-y-2 rounded-xl border border-[var(--border)] p-3">
                    <h3 className="text-sm font-bold">{t('stageD.encyclopedia.publication')}</h3>
                    <p className="text-xs text-[var(--muted)]">
                      {detail.living
                        ? t('stageD.encyclopedia.livingRule')
                        : t('stageD.encyclopedia.publicRule')}
                    </p>
                    {!detail.publishAllowed && detail.living ? (
                      <Field label={t('stageD.encyclopedia.consentNote')} htmlFor="consent-note">
                        <input
                          id="consent-note"
                          className="uf-input"
                          value={consentNote}
                          onChange={(e) => setConsentNote(e.target.value)}
                        />
                      </Field>
                    ) : null}
                    <Button
                      variant={detail.publishAllowed ? 'danger' : 'default'}
                      disabled={detail.visibility === 'private'}
                      onClick={() =>
                        void act(async () => {
                          await apiFetch(
                            `/encyclopedia/people/${encodeURIComponent(detail.id)}/publication`,
                            {
                              method: 'POST',
                              body: {
                                spaceId,
                                publish: !detail.publishAllowed,
                                livingConsent: detail.living && consentNote.trim().length >= 3,
                                consentNote: consentNote.trim(),
                              },
                            },
                          );
                          setConsentNote('');
                        })
                      }
                    >
                      {detail.publishAllowed
                        ? t('stageD.encyclopedia.unpublish')
                        : t('stageD.encyclopedia.publish')}
                    </Button>
                  </section>
                ) : null}
              </Card>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

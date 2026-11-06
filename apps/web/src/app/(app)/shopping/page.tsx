'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ShoppingList } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { useRealtimeReload } from '@/lib/use-realtime';

interface HistoryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  purchasedAt: string | null;
}

interface SuggestionItem {
  id: string | null;
  name: string;
  category: string;
  reason: string;
  autoOrdering: boolean;
}

export default function ShoppingPage() {
  const { t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, [
    'shopping',
    'shopping.presence',
  ]);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [listName, setListName] = useState('');
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('pcs');
  const [category, setCategory] = useState('other');
  const [joined, setJoined] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const [listRows, historyRows] = await Promise.all([
        apiFetch<ShoppingList[]>(apiPath('/shopping/lists', { spaceId })),
        apiFetch<HistoryItem[]>(apiPath('/shopping/history', { spaceId })),
      ]);
      setLists(listRows);
      setHistory(historyRows);
      setSelectedId((current) => current || listRows[0]?.id || '');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const selectedList = useMemo(
    () => lists.find((list) => list.id === selectedId) ?? null,
    [lists, selectedId],
  );

  const runAction = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    if (!spaceId || !online) {
      notify(t('error.offlineSave'), 'error');
      return null;
    }
    setActionBusy(true);
    try {
      const result = await apiFetch<Record<string, unknown>>(path, { method, body });
      refresh();
      return result;
    } catch {
      notify(t('common.error'), 'error');
      return null;
    } finally {
      setActionBusy(false);
    }
  };

  const createList = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!listName.trim()) return;
    const result = await runAction('/shopping/lists', {
      spaceId,
      name: listName.trim(),
      kind: 'grocery',
    });
    if (result) {
      setListName('');
      setSelectedId(String(result.id ?? ''));
    }
  };

  const addItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedList || !itemName.trim()) return;
    const result = await runAction('/shopping/items', {
      spaceId,
      listId: selectedList.id,
      name: itemName.trim(),
      quantity: Number(quantity),
      unit,
      category,
    });
    if (result) setItemName('');
  };

  const toggleItem = async (item: { id: string; checked: boolean }, list: ShoppingList) => {
    await runAction(
      `/shopping/items/${encodeURIComponent(item.id)}`,
      {
        spaceId,
        listId: list.id,
        expectedVersion: list.version,
        checked: !item.checked,
      },
      'PATCH',
    );
  };

  const claimItem = async (itemId: string, list: ShoppingList) => {
    await runAction(`/shopping/items/${encodeURIComponent(itemId)}/claim`, {
      spaceId,
      listId: list.id,
      expectedVersion: list.version,
    });
  };

  const deleteItem = async (itemId: string, list: ShoppingList) => {
    await runAction(
      apiPath(`/shopping/items/${encodeURIComponent(itemId)}`, {
        spaceId,
        listId: list.id,
      }),
      {},
      'DELETE',
    );
  };

  const merge = async () => {
    if (!selectedList) return;
    await runAction('/shopping/merge', { spaceId, listId: selectedList.id });
  };

  const generate = async () => {
    if (!selectedList) return;
    const result = await runAction('/shopping/generate', {
      spaceId,
      listId: selectedList.id,
    });
    if (result) notify(t('stageB.common.noAutoOrder'), 'success');
  };

  const joinPresence = async () => {
    if (!selectedList) return;
    const result = await runAction('/shopping/presence/join', {
      spaceId,
      listId: selectedList.id,
    });
    if (result) setJoined(true);
  };

  const leavePresence = async () => {
    if (!selectedList) return;
    const result = await runAction('/shopping/presence/leave', {
      spaceId,
      listId: selectedList.id,
    });
    if (result) setJoined(false);
  };

  const loadSuggestions = async () => {
    if (!spaceId) return;
    try {
      const result = await apiFetch<SuggestionItem[]>(
        apiPath('/shopping/suggestions', { spaceId }),
      );
      setSuggestions(result);
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const acceptSuggestion = async (id: string | null) => {
    if (!selectedList || !id) return;
    await runAction(`/shopping/suggestions/${encodeURIComponent(id)}/accept`, {
      spaceId,
      listId: selectedList.id,
    });
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stage.current')}
        title={t('modules.shopping')}
        description={t('stageB.shopping.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <Badge tone="accent">
              <Lucide.UsersRound className="h-3.5 w-3.5" />
              {selectedList?.presence.length ?? 0}
            </Badge>
            <Button onClick={() => void merge()} loading={actionBusy}>
              {t('stageB.common.merge')}
            </Button>
            <Button variant="primary" onClick={() => void generate()} loading={actionBusy}>
              {t('stageB.common.generate')}
            </Button>
          </div>
        }
      />

      {!spaceId ? (
        <EmptyState
          icon="UsersRound"
          title={t('common.noData')}
          description={t('admin.noAccess')}
        />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="uf-skeleton h-80" />
          <div className="uf-skeleton h-80" />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
          <div className="space-y-5">
            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.shopping.newList')}</h2>
              <form onSubmit={createList} className="space-y-3">
                <Field label={t('common.name')} htmlFor="shopping-list-name">
                  <input
                    id="shopping-list-name"
                    className="uf-input"
                    value={listName}
                    onChange={(event) => setListName(event.target.value)}
                    required
                    maxLength={120}
                  />
                </Field>
                <Button type="submit" variant="primary">
                  <Lucide.ListPlus className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.shopping.addItem')}</h2>
              <form onSubmit={addItem} className="space-y-3">
                <Field label={t('stageB.common.list')} htmlFor="shopping-list-select">
                  <select
                    id="shopping-list-select"
                    className="uf-select"
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name} · v{list.version}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('common.name')} htmlFor="shopping-item-name">
                  <input
                    id="shopping-item-name"
                    className="uf-input"
                    value={itemName}
                    onChange={(event) => setItemName(event.target.value)}
                    required
                    maxLength={200}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t('stageB.common.quantity')} htmlFor="shopping-quantity">
                    <input
                      id="shopping-quantity"
                      type="number"
                      min={0.01}
                      step={0.01}
                      className="uf-input"
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                  </Field>
                  <Field label={t('stageB.common.unit')} htmlFor="shopping-unit">
                    <input
                      id="shopping-unit"
                      className="uf-input"
                      value={unit}
                      onChange={(event) => setUnit(event.target.value)}
                      maxLength={30}
                    />
                  </Field>
                  <Field label={t('stageB.common.category')} htmlFor="shopping-category">
                    <input
                      id="shopping-category"
                      className="uf-input"
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                      maxLength={60}
                    />
                  </Field>
                </div>
                <Button type="submit" variant="primary">
                  <Lucide.Plus className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.shopping.presence')}</h2>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void joinPresence()} disabled={joined}>
                  {t('stageB.common.join')}
                </Button>
                <Button onClick={() => void leavePresence()} disabled={!joined}>
                  {t('stageB.common.leave')}
                </Button>
              </div>
              <div className="mt-4 space-y-2">
                {(selectedList?.presence ?? []).map((entry) => (
                  <div key={entry.userId} className="uf-card-soft p-3 text-xs">
                    <span className="uf-mono">{entry.userId.slice(-8)}</span> · {entry.status}
                  </div>
                ))}
                {(selectedList?.presence ?? []).length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
                ) : null}
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{t('stageB.shopping.items')}</h2>
                <Badge tone="accent">{selectedList?.items.length ?? 0}</Badge>
              </div>
              {!selectedList || selectedList.items.length === 0 ? (
                <EmptyState icon="ShoppingBasket" title={t('stageB.common.noData')} />
              ) : (
                <div className="space-y-3">
                  {selectedList.items.map((item) => (
                    <article key={item.id} className="uf-card-soft p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 accent-[var(--accent)]"
                            checked={item.checked}
                            onChange={() => void toggleItem(item, selectedList)}
                            aria-label={item.name}
                          />
                          <span>
                            <span
                              className={`font-bold ${item.checked ? 'line-through opacity-60' : ''}`}
                            >
                              {item.name}
                            </span>
                            <span className="mt-1 block text-xs text-[var(--muted)]">
                              {item.quantity} {item.unit} · {item.category}
                              {item.assignedUserId ? ` · ${item.assignedUserId.slice(-6)}` : ''}
                            </span>
                          </span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {item.checked ? (
                            <Badge tone="success">{t('common.checked')}</Badge>
                          ) : null}
                          <Button onClick={() => void claimItem(item.id, selectedList)}>
                            {t('stageB.common.claim')}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => void deleteItem(item.id, selectedList)}
                          >
                            <Lucide.Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{t('stageB.shopping.suggestions')}</h2>
                <Button onClick={() => void loadSuggestions()}>{t('common.refresh')}</Button>
              </div>
              <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                {t('stageB.common.noAutoOrder')}
              </p>
              {suggestions.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="space-y-2">
                  {suggestions.map((suggestion) => (
                    <div
                      key={suggestion.id ?? suggestion.name}
                      className="uf-card-soft flex items-center justify-between gap-3 p-3"
                    >
                      <div>
                        <p className="text-sm font-bold">{suggestion.name}</p>
                        <p className="text-xs text-[var(--muted)]">{suggestion.reason}</p>
                      </div>
                      <Button onClick={() => void acceptSuggestion(suggestion.id)}>
                        {t('stageB.common.apply')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.shopping.history')}</h2>
              {history.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="uf-table">
                    <thead>
                      <tr>
                        <th>{t('common.name')}</th>
                        <th>{t('stageB.common.quantity')}</th>
                        <th>{t('stageB.common.category')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.slice(0, 12).map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}</td>
                          <td>
                            {item.quantity} {item.unit}
                          </td>
                          <td className="text-[var(--muted)]">{item.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

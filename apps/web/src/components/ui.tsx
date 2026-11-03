'use client';

import React from 'react';
import clsx from 'clsx';
import * as Lucide from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApp } from './app-provider';

export function cn(...values: Array<string | false | null | undefined>): string {
  return clsx(values);
}

export function DynamicIcon({
  name,
  className = 'h-5 w-5',
  fallback = 'Boxes',
}: {
  name: string;
  className?: string;
  fallback?: string;
}) {
  const icons = Lucide as unknown as Record<string, LucideIcon>;
  const Icon = icons[name] ?? icons[fallback] ?? Lucide.Boxes;
  return <Icon className={className} aria-hidden="true" />;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3">
      <span className="relative inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-lg">
        <Lucide.HeartHandshake className="h-5 w-5" aria-hidden="true" />
        <span className="uf-decor absolute -right-1 -top-1 h-3 w-3 rounded-full bg-[var(--success)] ring-2 ring-[var(--surface)]" />
      </span>
      {!compact ? (
        <span className="leading-tight">
          <span className="block text-[0.98rem] font-extrabold tracking-tight">
            Ultra Family OS
          </span>
          <span className="block text-[0.68rem] font-semibold uppercase tracking-[0.15em] text-[var(--muted)]">
            Private by default
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function Card({
  children,
  className,
  soft = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { soft?: boolean }) {
  return (
    <div className={cn(soft ? 'uf-card-soft' : 'uf-card', className)} {...props}>
      {children}
    </div>
  );
}

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export function Button({
  variant = 'default',
  className,
  loading = false,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  return (
    <button
      className={cn(
        'uf-button',
        variant === 'primary' && 'uf-button-primary',
        variant === 'ghost' && 'uf-button-ghost',
        variant === 'danger' && 'uf-button-danger',
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Lucide.LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'default',
  className,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'uf-badge',
        tone === 'accent' && 'uf-badge-accent',
        tone === 'success' && 'uf-badge-success',
        tone === 'warning' && 'uf-badge-warning',
        tone === 'danger' && 'uf-badge-danger',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="uf-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="uf-switch"
    />
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        {eyebrow ? (
          <p className="mb-2 text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--accent-strong)]">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-3xl font-black tracking-tight md:text-4xl">{title}</h1>
        {description ? (
          <p className="mt-2 text-sm leading-6 text-[var(--muted)] md:text-base">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

export function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'accent',
}: {
  icon: string;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">{label}</p>
          <p className="mt-2 text-3xl font-black tracking-tight">{value}</p>
          {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
        </div>
        <span
          className={cn(
            'inline-flex h-11 w-11 items-center justify-center rounded-2xl',
            tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--accent-strong)]',
            tone === 'success' && 'bg-emerald-100 text-emerald-700',
            tone === 'warning' && 'bg-amber-100 text-amber-700',
            tone === 'danger' && 'bg-rose-100 text-rose-700',
          )}
        >
          <DynamicIcon name={icon} />
        </span>
      </div>
    </Card>
  );
}

export function EmptyState({
  icon = 'Inbox',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-soft)] text-[var(--muted)]">
        <DynamicIcon name={icon} className="h-7 w-7" />
      </span>
      <h3 className="text-lg font-bold">{title}</h3>
      {description ? <p className="max-w-lg text-sm text-[var(--muted)]">{description}</p> : null}
      {action}
    </Card>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useApp();
  return (
    <Card className="flex items-center justify-between gap-4 border-rose-300 p-5">
      <div className="flex items-center gap-3">
        <Lucide.TriangleAlert className="h-5 w-5 text-rose-500" aria-hidden="true" />
        <p className="text-sm font-semibold">{message}</p>
      </div>
      {onRetry ? (
        <Button onClick={onRetry}>
          <Lucide.RefreshCw className="h-4 w-4" />
          {t('common.retry')}
        </Button>
      ) : null}
    </Card>
  );
}

export function Avatar({
  name,
  color,
  size = 'md',
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-white',
        size === 'sm' && 'h-8 w-8 text-xs',
        size === 'md' && 'h-10 w-10 text-sm',
        size === 'lg' && 'h-14 w-14 text-lg',
      )}
      style={{ background: color || 'var(--accent)' }}
    >
      {letters || 'UF'}
    </span>
  );
}

export function LanguageSelect({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: 'ru' | 'it';
  onChange: (language: 'ru' | 'it') => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn('uf-select w-auto min-w-[7.2rem] py-2 text-sm font-semibold', className)}
      value={value}
      onChange={(event) => onChange(event.target.value as 'ru' | 'it')}
    >
      <option value="ru">RU</option>
      <option value="it">IT</option>
    </select>
  );
}

export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const percentage = Math.min(100, Math.max(0, (value / Math.max(max, 1)) * 100));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-soft)]"
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

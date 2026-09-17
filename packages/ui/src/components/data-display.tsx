'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { Skeleton } from './primitives';

/* ── Table ───────────────────────────────────────────────────────────────── */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Right-align numeric columns; money and counts read wrong when left-aligned. */
  align?: 'left' | 'right' | 'center';
  width?: string;
  render: (row: T) => React.ReactNode;
  /** Hidden below `md`, so a phone shows only what matters. */
  secondary?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
}

/**
 * The table every list screen uses.
 *
 * Loading renders skeleton *rows* rather than a spinner, so the layout does not jump when
 * data arrives — on a dense dashboard that shift is what makes an app feel cheap.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  onRowClick,
  empty,
  className,
}: DataTableProps<T>) {
  if (!loading && rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'px-4 py-3 text-xs font-medium uppercase tracking-wide text-content-subtle',
                  column.align === 'right'
                    ? 'text-right'
                    : column.align === 'center'
                      ? 'text-center'
                      : 'text-left',
                  column.secondary && 'hidden md:table-cell',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-line/60">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn('px-4 py-3.5', column.secondary && 'hidden md:table-cell')}
                    >
                      <Skeleton className={column.align === 'right' ? 'ml-auto w-16' : 'w-24'} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  // A clickable row is reachable by keyboard too; a div-with-onClick is
                  // the most common way a dashboard becomes unusable without a mouse.
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'border-b border-line/60 transition',
                    onRowClick &&
                      'cursor-pointer hover:bg-surface-sunken focus:bg-surface-sunken focus:outline-none',
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-4 py-3.5 text-content',
                        column.align === 'right'
                          ? 'text-right tabular'
                          : column.align === 'center'
                            ? 'text-center'
                            : 'text-left',
                        column.secondary && 'hidden md:table-cell',
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Pagination ──────────────────────────────────────────────────────────── */

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
  labels,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
  labels?: { previous?: string; next?: string; of?: string };
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3">
      <p className="text-sm text-content-muted tabular">
        {total} {labels?.of ?? 'ta'}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md px-3 py-1.5 text-sm text-content-muted transition hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40"
        >
          {labels?.previous ?? '‹'}
        </button>
        <span className="px-3 text-sm text-content tabular">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-md px-3 py-1.5 text-sm text-content-muted transition hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40"
        >
          {labels?.next ?? '›'}
        </button>
      </div>
    </div>
  );
}

/* ── Stat card ───────────────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  change,
  hint,
  loading,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  /** Percentage change against the comparable previous period. */
  change?: number;
  hint?: string;
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-raised p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-content-muted">{label}</p>
        {icon && <span className="text-content-subtle">{icon}</span>}
      </div>

      {loading ? (
        <Skeleton className="mt-3 h-8 w-28" />
      ) : (
        <p className="mt-2 text-2xl font-semibold text-content tabular">{value}</p>
      )}

      {change !== undefined && !loading && (
        <p
          className={cn(
            'mt-2 inline-flex items-center gap-1 text-sm tabular',
            // Zero is neutral, not "good". Colouring a flat week green is a small lie that
            // erodes trust in every other number on the page.
            change > 0 ? 'text-positive' : change < 0 ? 'text-critical' : 'text-content-subtle',
          )}
        >
          {change > 0 ? '↑' : change < 0 ? '↓' : '→'} {Math.abs(change)}%
          {hint && <span className="text-content-subtle">{hint}</span>}
        </p>
      )}
    </div>
  );
}

/* ── Sparkline ───────────────────────────────────────────────────────────── */

/**
 * A minimal trend line. Deliberately axis-free and label-free: it answers "is this going
 * up or down" at a glance, and anything more belongs on the analytics page.
 */
export function Sparkline({
  points,
  className,
  height = 40,
}: {
  points: number[];
  className?: string;
  height?: number;
}) {
  if (points.length < 2) return <div style={{ height }} className={className} />;

  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const width = 100;

  const path = points
    .map((value, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const rising = (points.at(-1) ?? 0) >= (points[0] ?? 0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full', className)}
      style={{ height }}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={rising ? 'rgb(var(--positive))' : 'rgb(var(--critical))'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

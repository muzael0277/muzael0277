'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { Button } from './primitives';

/* ── Modal ───────────────────────────────────────────────────────────────── */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const MODAL_SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

/**
 * A modal that behaves like one: Escape closes it, the backdrop closes it, focus moves
 * inside and the page behind stops scrolling. Each of those is a bug report waiting to
 * happen if left out.
 */
export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    // Without this the page behind scrolls under the modal on mobile, which feels broken.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog so a keyboard user is not left behind it.
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('input, button, [tabindex]')?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/40 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative w-full rounded-t-2xl bg-surface-raised shadow-overlay animate-slide-up',
          'sm:rounded-2xl',
          MODAL_SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="font-semibold text-content">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-content-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Yopish"
            className="-mr-1 rounded-md p-1 text-content-subtle transition hover:bg-surface-sunken hover:text-content"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation for destructive actions.
 *
 * The confirm button carries the danger styling and the *specific* verb ("Delete
 * product"), not a generic "OK" — people click OK reflexively.
 */
export function ConfirmDialog({
  open, onClose, onConfirm, title, message, confirmLabel, cancelLabel = 'Bekor qilish', loading, tone = 'danger',
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: string; confirmLabel: string; cancelLabel?: string;
  loading?: boolean; tone?: 'danger' | 'primary';
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      <p className="text-sm text-content-muted">{message}</p>
    </Modal>
  );
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(0);

  const show = React.useCallback((message: string, tone: ToastTone = 'info') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, tone, message }]);
    // Errors stay longer: they usually carry something the user needs to read.
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, tone === 'error' ? 6000 : 3500);
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      show,
      success: (message) => show(message, 'success'),
      error: (message) => show(message, 'error'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
        // Announced by screen readers without stealing focus.
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-raised animate-slide-up',
              toast.tone === 'success' && 'bg-positive text-white',
              toast.tone === 'error' && 'bg-critical text-white',
              toast.tone === 'info' && 'bg-surface-raised text-content border border-line',
            )}
          >
            <span className="flex-1">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

export function Tabs({ tabs, active, onChange, className }: {
  tabs: { key: string; label: React.ReactNode; count?: number }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-line', className)} role="tablist">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.key)}
            className={cn(
              'relative whitespace-nowrap px-4 py-2.5 text-sm font-medium transition',
              selected ? 'text-brand' : 'text-content-muted hover:text-content',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={cn(
                'ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular',
                selected ? 'bg-brand-subtle text-brand' : 'bg-surface-sunken text-content-subtle',
              )}>
                {tab.count}
              </span>
            )}
            {selected && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}

'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

/* ── Button ──────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:brightness-110 active:brightness-95 shadow-sm',
  secondary: 'bg-surface-raised text-content border border-line hover:bg-surface-sunken',
  ghost: 'text-content-muted hover:bg-surface-sunken hover:text-content',
  danger: 'bg-critical text-white hover:brightness-110 active:brightness-95',
  subtle: 'bg-brand-subtle text-brand hover:brightness-95',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading,
      icon,
      fullWidth,
      children,
      disabled,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      // A loading button stays disabled: double-submitting a checkout is the exact
      // failure the idempotency layer exists to catch, and not causing it is better.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Field ───────────────────────────────────────────────────────────────── */

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps a control with its label, hint and error.
 *
 * The error replaces the hint rather than stacking, so a form does not grow taller as it
 * gets more wrong — and the message is wired with aria-describedby so a screen reader
 * announces it with the field.
 */
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = React.useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-content">
          {label}
          {required && (
            <span className="ml-0.5 text-critical" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement, {
            id,
            'aria-describedby': describedBy,
            'aria-invalid': error ? true : undefined,
          })
        : children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-content-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL = cn(
  'w-full rounded-lg border border-line bg-surface-raised px-3 text-sm text-content',
  'placeholder:text-content-subtle transition',
  'focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none',
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-subtle',
  'aria-[invalid=true]:border-critical aria-[invalid=true]:focus:ring-critical/20',
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(CONTROL, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(CONTROL, 'min-h-24 py-2', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(CONTROL, 'h-10 pr-8', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

/**
 * Money input.
 *
 * Shows grouped thousands while typing and reports the raw minor-unit integer, so a
 * caller never handles a formatted string or a float.
 */
export function MoneyInput({
  value,
  onChange,
  currency = "so'm",
  ...props
}: { value: number; onChange: (value: number) => void; currency?: string } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const display = value === 0 ? '' : value.toLocaleString('ru-RU').replace(/ /g, ' ');

  return (
    <div className="relative">
      <Input
        {...props}
        inputMode="numeric"
        value={display}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, '');
          onChange(digits === '' ? 0 : Number(digits));
        }}
        className="pr-14 tabular"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-content-subtle">
        {currency}
      </span>
    </div>
  );
}

/* ── Surfaces ────────────────────────────────────────────────────────────── */

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-line bg-surface-raised shadow-card', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-line px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="truncate font-semibold text-content">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-content-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type BadgeTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-content-muted border-line',
  positive: 'bg-positive/10 text-positive border-positive/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  critical: 'bg-critical/10 text-critical border-critical/20',
  info: 'bg-info/10 text-info border-info/20',
  brand: 'bg-brand-subtle text-brand border-brand/20',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden />;
}

/**
 * Empty state.
 *
 * Never a blank screen: an empty list gets an explanation and, where one exists, the
 * action that fills it. "No customers yet — they will appear here once your bot is live"
 * tells the owner the system is working; a blank table tells them it is broken.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-content-subtle">
          {icon}
        </div>
      )}
      <p className="font-medium text-content">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-content-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Qayta urinish',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-critical/10 text-critical">
        !
      </div>
      <p className="text-sm text-content">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

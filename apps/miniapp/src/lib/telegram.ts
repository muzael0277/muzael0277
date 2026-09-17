'use client';

/**
 * The Telegram WebApp bridge.
 *
 * Everything here is optional at runtime: the Mini App must also work when opened in a
 * plain browser, which is how it gets developed and demonstrated. So each call is guarded
 * rather than assumed, and a missing `window.Telegram` degrades to sensible defaults
 * instead of a white screen.
 */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: { id: number; first_name: string; language_code?: string };
    start_param?: string;
  };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  viewportStableHeight: number;
  ready: () => void;
  expand: () => void;
  close: () => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
  MainButton: {
    text: string;
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    setText: (text: string) => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    enable: () => void;
    disable: () => void;
  };
  BackButton: {
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function isInsideTelegram(): boolean {
  const app = webApp();
  return Boolean(app?.initData);
}

/** Announces readiness and takes the full height; safe to call more than once. */
export function initTelegram(): void {
  const app = webApp();
  if (!app) return;
  app.ready();
  app.expand();
}

/**
 * Light haptic feedback on meaningful actions.
 *
 * Used sparingly — adding an item to the cart, confirming a booking. Buzzing on every tap
 * is the mobile equivalent of a page full of toasts.
 */
export function haptic(kind: 'light' | 'success' | 'error' = 'light'): void {
  const feedback = webApp()?.HapticFeedback;
  if (!feedback) return;
  if (kind === 'light') feedback.impactOccurred('light');
  else feedback.notificationOccurred(kind === 'success' ? 'success' : 'error');
}

/**
 * Drives Telegram's native main button.
 *
 * Preferred over an in-page button for the primary action: it sits above the keyboard,
 * matches the user's theme, and is where a Telegram user already looks.
 */
export function useMainButton(
  label: string | null,
  onClick: () => void,
  options: { loading?: boolean; disabled?: boolean } = {},
): void {
  const handler = React.useRef(onClick);
  handler.current = onClick;

  React.useEffect(() => {
    const app = webApp();
    if (!app?.MainButton) return;

    const button = app.MainButton;
    const callback = () => handler.current();

    if (!label) {
      button.hide();
      return;
    }

    button.setText(label);
    button.show();
    button.onClick(callback);

    if (options.loading) button.showProgress(true);
    else button.hideProgress();

    if (options.disabled) button.disable();
    else button.enable();

    return () => {
      button.offClick(callback);
      button.hide();
      button.hideProgress();
    };
  }, [label, options.loading, options.disabled]);
}

import * as React from 'react';

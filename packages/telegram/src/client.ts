import type { TgBotInfo, TgReplyMarkup, TgSendMessageOptions, TgUpdate } from './types';

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = 'TelegramApiError';
  }

  /** 403 with this description means the customer blocked the bot — stop sending. */
  get isBotBlocked(): boolean {
    return (
      this.errorCode === 403 &&
      /bot was blocked|user is deactivated|chat not found/i.test(this.description)
    );
  }

  get isRateLimited(): boolean {
    return this.errorCode === 429;
  }
}

/**
 * Bot API client.
 *
 * One instance per bot, because tokens are per tenant (docs/architecture/07-telegram.md).
 * Rate limiting lives here rather than at the call sites: Telegram allows roughly 30
 * messages/second overall and about 20/minute to one chat, and exceeding it gets a bot
 * throttled or banned — which for a tenant means their customers stop hearing from them.
 */
export class TelegramClient {
  private readonly apiBase: string;
  private lastSendAt = 0;
  private readonly minIntervalMs: number;

  constructor(
    private readonly botToken: string,
    options: { apiBase?: string; messagesPerSecond?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.apiBase = options.apiBase ?? 'https://api.telegram.org';
    this.minIntervalMs = Math.ceil(1000 / (options.messagesPerSecond ?? 25));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  async call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    await this.pace();

    const response = await this.fetchImpl(`${this.apiBase}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const body = (await response.json()) as {
      ok: boolean; result?: T; error_code?: number; description?: string;
      parameters?: { retry_after?: number };
    };

    if (!body.ok) {
      throw new TelegramApiError(
        method,
        body.error_code ?? response.status,
        body.description ?? 'Unknown error',
        body.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  getMe() { return this.call<TgBotInfo>('getMe'); }

  sendMessage(chatId: number | string, text: string, options?: TgSendMessageOptions) {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options?.parse_mode ?? 'HTML',
      reply_markup: options?.reply_markup,
      disable_web_page_preview: options?.disable_web_page_preview ?? true,
      reply_to_message_id: options?.reply_to_message_id,
    });
  }

  editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: TgReplyMarkup) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }

  setWebhook(url: string, secretToken: string, allowedUpdates?: string[]) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: allowedUpdates ?? ['message', 'callback_query', 'my_chat_member', 'pre_checkout_query'],
      drop_pending_updates: false,
    });
  }

  deleteWebhook() { return this.call<boolean>('deleteWebhook', { drop_pending_updates: false }); }

  getUpdates(offset?: number, timeoutSeconds = 25) {
    return this.call<TgUpdate[]>('getUpdates', {
      offset, timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
  }

  setMyCommands(commands: { command: string; description: string }[], languageCode?: string) {
    return this.call<boolean>('setMyCommands', { commands, language_code: languageCode });
  }

  setChatMenuButton(webAppUrl: string, text: string) {
    return this.call<boolean>('setChatMenuButton', {
      menu_button: { type: 'web_app', text, web_app: { url: webAppUrl } },
    });
  }

  /** Simple spacing between sends; the queue handles larger-scale pacing. */
  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastSendAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastSendAt = Date.now();
  }
}

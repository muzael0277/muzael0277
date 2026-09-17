import { describe, it, expect } from 'vitest';
import { verifyInitData, signInitData, DEFAULT_MAX_AGE_SECONDS } from '../init-data';

/**
 * Mini App authentication.
 *
 * Anyone can open a Mini App URL and edit the payload before it reaches us, so this
 * verification *is* the authentication. A hole here is a complete bypass: an attacker
 * could claim to be any customer of any business.
 */
const BOT_TOKEN = '8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OTHER_TOKEN = '9987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';

const now = new Date('2026-09-17T12:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000));

const user = JSON.stringify({
  id: 501111111,
  first_name: 'Aziz',
  last_name: 'Karimov',
  username: 'aziz_uz',
  language_code: 'uz',
});

const validInitData = (over: Record<string, string> = {}, token = BOT_TOKEN) =>
  signInitData({ user, auth_date: authDate, chat_instance: '-123', ...over }, token);

describe('verifyInitData', () => {
  it('accepts a correctly signed payload and returns the user', () => {
    const result = verifyInitData(validInitData(), BOT_TOKEN, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user?.id).toBe(501111111);
    expect(result.data.user?.username).toBe('aziz_uz');
    expect(result.data.auth_date).toBe(Number(authDate));
  });

  it('rejects a payload signed with a different bot token', () => {
    // This is the cross-tenant case: one business's bot must not authenticate into another.
    const result = verifyInitData(validInitData({}, OTHER_TOKEN), BOT_TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('rejects a payload whose user was tampered with after signing', () => {
    const signed = validInitData();
    const params = new URLSearchParams(signed);
    params.set('user', JSON.stringify({ id: 999, first_name: 'Attacker' }));
    const result = verifyInitData(params.toString(), BOT_TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('rejects a payload with no hash at all', () => {
    const params = new URLSearchParams({ user, auth_date: authDate });
    expect(verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: 'MISSING_HASH',
    });
  });

  it('rejects an empty hash', () => {
    const params = new URLSearchParams({ user, auth_date: authDate, hash: '' });
    expect(verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: 'MISSING_HASH',
    });
  });

  it('rejects a stale payload, limiting the window for a captured one', () => {
    const old = String(Math.floor(now.getTime() / 1000) - DEFAULT_MAX_AGE_SECONDS - 60);
    const result = verifyInitData(validInitData({ auth_date: old }), BOT_TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('accepts a payload just inside the freshness window', () => {
    const recent = String(Math.floor(now.getTime() / 1000) - DEFAULT_MAX_AGE_SECONDS + 60);
    expect(verifyInitData(validInitData({ auth_date: recent }), BOT_TOKEN, { now }).ok).toBe(true);
  });

  it('rejects a missing or malformed auth_date rather than treating it as fresh', () => {
    const noDate = signInitData({ user }, BOT_TOKEN);
    expect(verifyInitData(noDate, BOT_TOKEN, { now }).ok).toBe(false);

    // Genuinely signed, but the timestamp is nonsense. The signature check passes and the
    // payload is still rejected — MALFORMED rather than SIGNATURE_INVALID, because
    // conflating "forged" with "malformed" would make a real forgery harder to spot in
    // the logs.
    const badDate = validInitData({ auth_date: 'yesterday' });
    expect(verifyInitData(badDate, BOT_TOKEN, { now })).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('rejects a payload whose user field is not valid JSON', () => {
    const params = new URLSearchParams(
      signInitData({ user: '{broken', auth_date: authDate }, BOT_TOKEN),
    );
    expect(verifyInitData(params.toString(), BOT_TOKEN, { now })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('is not fooled by reordering the fields', () => {
    // Telegram signs a canonical sorted form, so a reordered query string must still
    // verify — and must not be a way to smuggle a different signature past us.
    const signed = validInitData();
    const params = new URLSearchParams(signed);
    const reordered = new URLSearchParams();
    for (const key of [...params.keys()].reverse()) reordered.set(key, params.get(key)!);
    expect(verifyInitData(reordered.toString(), BOT_TOKEN, { now }).ok).toBe(true);
  });

  it('carries a start parameter through, for deep links like a table QR code', () => {
    const result = verifyInitData(validInitData({ start_param: 'table_12' }), BOT_TOKEN, { now });
    expect(result.ok && result.data.start_param).toBe('table_12');
  });

  it('accepts a payload with extra fields Telegram may add later', () => {
    // Forward compatibility: unknown fields are part of the signed data, not a reason to
    // reject a session.
    const result = verifyInitData(
      validInitData({ signature: 'abc', some_future_field: 'x' }),
      BOT_TOKEN,
      { now },
    );
    expect(result.ok).toBe(true);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyTelegramInitData } from '../security.js';

const botToken = '123456:TEST_TOKEN';
const now = 1_800_000_000;

function makeInitData(fields, token = botToken) {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}

test('accepts a valid, recent Telegram initData payload', () => {
  const raw = makeInitData({
    auth_date: String(now),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: 123456, username: 'green_player', first_name: 'Green' })
  });
  assert.deepEqual(verifyTelegramInitData(raw, botToken, now), {
    id: '123456', username: 'green_player', firstName: 'Green'
  });
});

test('rejects a modified payload', () => {
  const raw = makeInitData({ auth_date: String(now), user: JSON.stringify({ id: 123 }) });
  assert.throws(() => verifyTelegramInitData(raw + '&extra=changed', botToken, now), /signature/i);
});

test('rejects duplicate parameters, including non-auth fields', () => {
  const raw = makeInitData({ auth_date: String(now), user: JSON.stringify({ id: 123 }) });
  assert.throws(() => verifyTelegramInitData(raw + '&query_id=one&query_id=two', botToken, now), /duplicate/i);
});

test('rejects expired and future-dated payloads', () => {
  const expired = makeInitData({ auth_date: String(now - 301), user: JSON.stringify({ id: 123 }) });
  const future = makeInitData({ auth_date: String(now + 31), user: JSON.stringify({ id: 123 }) });
  assert.throws(() => verifyTelegramInitData(expired, botToken, now), /expired/i);
  assert.throws(() => verifyTelegramInitData(future, botToken, now), /expired/i);
});

test('rejects malformed user identity', () => {
  const raw = makeInitData({ auth_date: String(now), user: JSON.stringify({ id: 'not-a-number' }) });
  assert.throws(() => verifyTelegramInitData(raw, botToken, now), /user id/i);
});

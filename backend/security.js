import crypto from 'node:crypto';

export function verifyTelegramInitData(raw, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    throw new Error('Invalid initData');
  }
  if (typeof botToken !== 'string' || !botToken) throw new Error('Telegram bot token is missing');

  const params = new URLSearchParams(raw);
  const seen = new Set();
  for (const [key] of params) {
    if (seen.has(key)) throw new Error('Duplicate initData parameter');
    seen.add(key);
  }

  const hashValues = params.getAll('hash');
  const authDates = params.getAll('auth_date');
  const users = params.getAll('user');
  if (hashValues.length !== 1 || authDates.length !== 1 || users.length !== 1) {
    throw new Error('Invalid initData fields');
  }

  const suppliedHash = hashValues[0];
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!/^[a-f0-9]{64}$/i.test(suppliedHash)) throw new Error('Bad Telegram signature');
  const supplied = Buffer.from(suppliedHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new Error('Bad Telegram signature');
  }

  const authDate = Number(authDates[0]);
  if (!Number.isInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > 300) {
    throw new Error('Expired Telegram data');
  }

  let user;
  try { user = JSON.parse(users[0]); } catch { throw new Error('Invalid Telegram user'); }
  if (!user || typeof user !== 'object' || Array.isArray(user) || !/^\\d{1,20}$/.test(String(user.id))) {
    throw new Error('Bad user id');
  }

  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username.slice(0, 64) : null,
    firstName: typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : ''
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { redactAccountIdentifiers } from '../src/platform/security/redaction.js';

test('redactAccountIdentifiers strips known account-identifying fields', () => {
  const raw = JSON.stringify({
    user_id: 'ee33acab-1234-5678',
    account_id: 'acc-789',
    device_id: 'dev-abc',
    client_id: 'GA1.2.111.222',
    cid: '111.222',
    referral_code: 'D9Km8Jkz',
    referral_id: 'ref-456',
    telegram_id: 'tg-999',
  });
  const redacted = redactAccountIdentifiers(raw);
  const parsed = JSON.parse(redacted) as Record<string, string>;
  for (const key of ['user_id', 'account_id', 'device_id', 'client_id', 'cid', 'referral_code', 'referral_id', 'telegram_id']) {
    assert.equal(parsed[key], '[REDACTED]', `${key} must be redacted`);
  }
});

test('redactAccountIdentifiers leaves legitimate research data untouched', () => {
  const raw = JSON.stringify({
    token_address: '3JLTNKH78VMd3j7kQkHDC7RqdasCAGwsLQdm3BBLpump',
    wallet_address: '7JFSAQbodH8otbLx1K6hzjT3CU7k71VmpReLu4mMNYrV',
    price_usd: '0.0000021810772',
    user_name: 'a display name, not an id, must survive',
  });
  const redacted = redactAccountIdentifiers(raw);
  assert.equal(redacted, raw, 'non-identifier fields, including wallet/token addresses, must pass through unchanged');
});

test('redactAccountIdentifiers is case-insensitive on the key name and preserves surrounding JSON structure', () => {
  const raw = '{"USER_ID":"secret-value","other":"kept"}';
  const redacted = redactAccountIdentifiers(raw);
  const parsed = JSON.parse(redacted) as Record<string, string>;
  assert.equal(parsed.USER_ID, '[REDACTED]');
  assert.equal(parsed.other, 'kept');
});

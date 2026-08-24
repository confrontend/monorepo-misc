import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
};

const configuredSecrets = (): string[] => {
  const apiKeyPath = path.join(findProjectRoot(), '.secrets', 'gmgn', 'gmgn-api-key.txt');
  if (!existsSync(apiKeyPath)) return [];
  const value = readFileSync(apiKeyPath, 'utf8').trim();
  return value ? [value] : [];
};

/** Redacts configured local credentials and common credential encodings before persistence or UI output. */
export const redactSensitiveText = (value: string, secrets = configuredSecrets()): string => {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED_API_KEY]');
  return redacted
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, '$1[REDACTED]')
    .replace(/(GMGN_API_KEY\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/("(?:api_?key|token|secret)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    .replace(
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,
      '[REDACTED_PRIVATE_KEY]',
    );
};

export const redactDiagnosticValue = (value: unknown): string =>
  redactSensitiveText(JSON.stringify(value));

// Field names confirmed present in a real GMGN browser-extension investigation capture
// (progress.md 2026-08-17): user_id, referral_code, and GA/device identifiers travel alongside
// legitimate research data (token addresses, prices, trade rows) in the same raw export. None
// of these are secrets — redactSensitiveText above deliberately doesn't touch them — but they
// identify a real person's GMGN account and must never leave local storage unredacted.
// Matching too broadly here is the safe failure mode (unlike guessing a research field's
// meaning elsewhere in this project): an over-redacted account ID costs nothing, an
// under-redacted one is a real privacy leak.
const ACCOUNT_IDENTIFIER_KEYS = [
  'user_id',
  'account_id',
  'device_id',
  'client_id',
  'cid',
  'referral_code',
  'referral_id',
  'telegram_id',
];
const accountIdentifierPattern = new RegExp(
  `("(?:${ACCOUNT_IDENTIFIER_KEYS.join('|')})"\\s*:\\s*")[^"]*(")`,
  'gi',
);

/** Strips account-identifying values from raw investigation JSON before it is persisted or
 *  archived. Does NOT redact wallet addresses — this app's entire research value depends on
 *  keeping wallet/token addresses intact, and there is no reliable way to tell "the extension
 *  owner's own wallet" apart from a legitimately-researched wallet address in a generic capture. */
export const redactAccountIdentifiers = (value: string): string =>
  value.replace(accountIdentifierPattern, '$1[REDACTED]$2');

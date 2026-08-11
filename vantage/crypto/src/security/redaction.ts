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
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[REDACTED_PRIVATE_KEY]');
};

export const redactDiagnosticValue = (value: unknown): string =>
  redactSensitiveText(JSON.stringify(value));

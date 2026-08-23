import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GmgnCredentialStatus = {
  configured: boolean;
  keyPath: string;
  publicKeyConfigured: boolean;
  keyBytes: number;
  message: string;
};

// Walk upward so both src (tsx) and dist/src (compiled) builds find the same root.
const findProjectRoot = (): string => {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
};
const projectRoot = findProjectRoot();
const keyPath = path.join(projectRoot, '.secrets', 'gmgn', 'gmgn-api-key.txt');
const publicKeyPath = path.join(projectRoot, '.secrets', 'gmgn', 'gmgn-ed25519-public.pem');

/** Reads only credential metadata. The secret itself never leaves the server process. */
export const readGmgnCredentialStatus = (): GmgnCredentialStatus => {
  const configured = existsSync(keyPath) && readFileSync(keyPath, 'utf8').trim().length > 0;
  const publicKeyConfigured = existsSync(publicKeyPath);
  const keyBytes = configured ? statSync(keyPath).size : 0;
  return {
    configured,
    keyPath: '.secrets/gmgn/gmgn-api-key.txt',
    publicKeyConfigured,
    keyBytes,
    message: configured
      ? 'API credential found locally. It is not stored in SQLite or logs.'
      : 'Add the API key to .secrets/gmgn/gmgn-api-key.txt, then check again.',
  };
};

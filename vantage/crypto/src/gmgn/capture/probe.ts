import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from '../../platform/security/redaction.js';
import { waitForGmgnRequest } from '../client/rateLimit.js';
import { findProjectRoot } from '../../platform/archive.js';

const execFileAsync = promisify(execFile);
const projectRoot = findProjectRoot();
const keyPath = path.join(projectRoot, '.secrets', 'gmgn', 'gmgn-api-key.txt');
const diagnosticsPath = path.join(projectRoot, '.data', 'gmgn-probe-diagnostics.log');

const writeDiagnostics = (details: Record<string, unknown>, secret: string): void => {
  mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
  const text = redactSensitiveText(JSON.stringify(details), [secret]);
  appendFileSync(diagnosticsPath, `${text}\n`, { encoding: 'utf8' });
};

export type GmgnProbeResult = {
  ok: boolean;
  status: 'connected' | 'not-installed' | 'not-configured' | 'error';
  message: string;
  observedItems: number | null;
  checkedAt: string;
};

export const probeGmgn = async (): Promise<GmgnProbeResult> => {
  const checkedAt = new Date().toISOString();
  const secret = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
  if (!secret) {
    return {
      ok: false,
      status: 'not-configured',
      message: 'API key file is empty or missing.',
      observedItems: null,
      checkedAt,
    };
  }
  const localScript = path.join(projectRoot, 'node_modules', 'gmgn-cli', 'dist', 'index.js');
  const useLocal = existsSync(localScript);
  const command = useLocal
    ? process.execPath
    : process.platform === 'win32'
      ? 'gmgn-cli.cmd'
      : 'gmgn-cli';
  const args = useLocal
    ? [localScript, 'market', 'signal', '--chain', 'sol', '--raw']
    : ['market', 'signal', '--chain', 'sol', '--raw'];
  try {
    await waitForGmgnRequest();
    const { stdout } = await execFileAsync(command, args, {
      cwd: projectRoot,
      env: { ...process.env, GMGN_API_KEY: secret },
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: !useLocal && process.platform === 'win32',
    });
    let observedItems: number | null = null;
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) observedItems = parsed.length;
      else if (
        parsed &&
        typeof parsed === 'object' &&
        'list' in parsed &&
        Array.isArray(parsed.list)
      )
        observedItems = (parsed as { list: unknown[] }).list.length;
    } catch {
      /* CLI may wrap JSON in human-readable output; status still proves the request completed. */
    }
    return {
      ok: true,
      status: 'connected',
      message:
        'GMGN read-only signal request completed. Raw response was not retained by the probe.',
      observedItems,
      checkedAt,
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const details = `${code} ${stderr}`.toLowerCase();
    writeDiagnostics(
      {
        checkedAt,
        command,
        args,
        errorCode: code || null,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        stderr,
        stdoutBytes:
          error &&
          typeof error === 'object' &&
          'stdout' in error &&
          typeof (error as { stdout?: unknown }).stdout === 'string'
            ? Buffer.byteLength((error as { stdout: string }).stdout, 'utf8')
            : null,
        apiKeyPresent: true,
      },
      secret,
    );
    if (
      code === 'ENOENT' ||
      details.includes('not recognized') ||
      details.includes('cannot find the path')
    ) {
      return {
        ok: false,
        status: 'not-installed',
        message: 'The project-local gmgn-cli is unavailable. Run npm install, then check again.',
        observedItems: null,
        checkedAt,
      };
    }
    if (
      details.includes('401') ||
      details.includes('unauthorized') ||
      details.includes('invalid api')
    ) {
      return {
        ok: false,
        status: 'error',
        message:
          'GMGN rejected the credential (401/unauthorized). Recheck the API key in the local file.',
        observedItems: null,
        checkedAt,
      };
    }
    if (details.includes('403') || details.includes('forbidden')) {
      return {
        ok: false,
        status: 'error',
        message:
          'GMGN denied this read-only request (403/forbidden). Check API-key reading permission and IP restrictions.',
        observedItems: null,
        checkedAt,
      };
    }
    if (details.includes('429') || details.includes('rate limit')) {
      return {
        ok: false,
        status: 'error',
        message:
          'GMGN rate-limited the request (429). Wait for the documented reset time before retrying.',
        observedItems: null,
        checkedAt,
      };
    }
    return {
      ok: false,
      status: 'error',
      message:
        'GMGN read-only request failed. Safe diagnostics saved to .data/gmgn-probe-diagnostics.log.',
      observedItems: null,
      checkedAt,
    };
  }
};

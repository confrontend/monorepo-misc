import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { logDiagnostic } from '../platform/db/diagnostics.js';

export type RequestLogContext = {
  database: DatabaseSync;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  startedAt: number;
  requestBytes: number | null;
};

export const attachClientDisconnectLogging = (
  context: RequestLogContext,
  isResponded: () => boolean,
): void => {
  context.response.once('close', () => {
    if (isResponded()) return;
    logDiagnostic(context.database, {
      level: 'warn',
      event: 'client-disconnected',
      method: context.request.method ?? null,
      path: context.path,
      durationMs: Date.now() - context.startedAt,
      requestBytes: context.requestBytes,
      message: 'Connection closed before a response was sent (client abort or connection reset).',
    });
  });
};

export const logRequestComplete = (context: RequestLogContext, status: number): void => {
  if (context.request.method === 'GET' && status < 400) return;
  logDiagnostic(context.database, {
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    event: 'request-complete',
    method: context.request.method ?? null,
    path: context.path,
    status,
    durationMs: Date.now() - context.startedAt,
    requestBytes: context.requestBytes,
  });
};

export const logRequestError = (
  context: RequestLogContext,
  message: string,
  error?: unknown,
): void => {
  logDiagnostic(context.database, {
    level: 'error',
    event: 'request-error',
    method: context.request.method ?? null,
    path: context.path,
    status: 400,
    durationMs: Date.now() - context.startedAt,
    requestBytes: context.requestBytes,
    message,
    detail: error instanceof Error ? { stack: error.stack } : undefined,
  });
};

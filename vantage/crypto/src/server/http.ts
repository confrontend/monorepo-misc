import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024;

export const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
};

export const readJsonBody = async (
  request: IncomingMessage,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes)
      throw new Error(`Request is larger than ${Math.floor(maxBodyBytes / (1024 * 1024))} MB.`);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const mimeType = (filePath: string): string => {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html; charset=utf-8';
};

/** Serve the built UI without allowing a request path to escape the UI root. */
export const serveStaticFile = (
  requestPath: string,
  uiRoot: string,
  response: ServerResponse,
): void => {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  const filePath = path.resolve(uiRoot, relative);
  if (!filePath.startsWith(`${uiRoot}${path.sep}`) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': mimeType(filePath) });
  response.end(readFileSync(filePath));
};

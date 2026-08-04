// Minimal Gmail REST API client. Reads only — never sends, modifies, or deletes.

export interface GmailMessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Thrown specifically for a 401 -- the access token is expired or revoked.
// Callers can catch this to distinguish "you need to reconnect" from any
// other Gmail API failure (rate limit, bad request, etc).
export class GmailAuthError extends Error {}

async function gmailFetch(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    throw new GmailAuthError('Gmail access token expired or was revoked.');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${body}`);
  }
  return res.json();
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string }>;
}

interface GmailMessageHeader {
  name: string;
  value: string;
}

interface GmailMessageResponse {
  id: string;
  snippet?: string;
  payload?: {
    headers?: GmailMessageHeader[];
  };
}

// Fetches the single most recent message in the account's inbox and returns
// just enough parsed fields to prove the connection is real and readable.
export async function fetchLatestEmail(accessToken: string): Promise<GmailMessageSummary> {
  const list = (await gmailFetch('/messages?maxResults=1', accessToken)) as GmailMessageListResponse;
  const messages = list.messages;
  if (!messages || messages.length === 0) {
    throw new Error('No messages found in this Gmail account.');
  }

  const messageId = messages[0].id;
  const message = (await gmailFetch(
    `/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    accessToken,
  )) as GmailMessageResponse;

  const headers = message.payload?.headers ?? [];
  const getHeader = (name: string) => headers.find((h) => h.name === name)?.value ?? '(unknown)';

  return {
    id: message.id,
    from: getHeader('From'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    snippet: message.snippet ?? '',
  };
}

// Only messages from seekingalpha.com are in scope for the inbox view.
const SEEKING_ALPHA_QUERY = 'from:seekingalpha.com';

export interface EmailListPage {
  items: GmailMessageSummary[];
  nextPageToken?: string;
}

interface GmailMessageListResponseWithToken extends GmailMessageListResponse {
  nextPageToken?: string;
}

// Fetches one page of seekingalpha.com messages. Gmail's API paginates with
// an opaque pageToken (not a page number) — pass the token this returned last
// time to get the next page, or omit it for the first page.
export async function listSeekingAlphaEmails(
  accessToken: string,
  options: { pageToken?: string; pageSize: number },
): Promise<EmailListPage> {
  const params = new URLSearchParams({
    q: SEEKING_ALPHA_QUERY,
    maxResults: String(options.pageSize),
  });
  if (options.pageToken) {
    params.set('pageToken', options.pageToken);
  }

  const list = (await gmailFetch(`/messages?${params.toString()}`, accessToken)) as GmailMessageListResponseWithToken;
  const refs = list.messages ?? [];

  const items = await Promise.all(
    refs.map(async ({ id }) => {
      const message = (await gmailFetch(
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        accessToken,
      )) as GmailMessageResponse;
      const headers = message.payload?.headers ?? [];
      const getHeader = (name: string) => headers.find((h) => h.name === name)?.value ?? '(unknown)';
      return {
        id: message.id,
        from: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        snippet: message.snippet ?? '',
      };
    }),
  );

  return { items, nextPageToken: list.nextPageToken };
}

// Gmail encodes message body data as base64url (RFC 4648 sec. 5): '-' / '_'
// instead of '+' / '/', and no padding. Convert to standard base64 before
// using atob() or embedding in a data: URI.
function base64UrlToStandard(data: string): string {
  const withPadding = data.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (withPadding.length % 4)) % 4;
  return withPadding + '='.repeat(paddingNeeded);
}

// Decodes a base64url text part into a proper UTF-8 string (not just Latin-1
// via atob alone, which mangles non-ASCII characters like curly quotes).
function decodeBase64UrlText(data: string): string {
  const binary = atob(base64UrlToStandard(data));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

interface GmailMimePart {
  mimeType?: string;
  headers?: GmailMessageHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailMimePart[];
}

interface GmailFullMessageResponse {
  id: string;
  payload?: GmailMimePart;
}

interface InlineImageRef {
  attachmentId: string;
  mimeType: string;
}

function collectBodyParts(
  part: GmailMimePart,
  collector: { htmlData?: string; textData?: string; inlineImages: Map<string, InlineImageRef> },
): void {
  const mimeType = part.mimeType ?? '';
  if (mimeType === 'text/html' && part.body?.data && !collector.htmlData) {
    collector.htmlData = part.body.data;
  } else if (mimeType === 'text/plain' && part.body?.data && !collector.textData) {
    collector.textData = part.body.data;
  } else if (mimeType.startsWith('image/') && part.body?.attachmentId) {
    const contentId = (part.headers ?? []).find((h) => h.name.toLowerCase() === 'content-id')?.value;
    if (contentId) {
      collector.inlineImages.set(contentId.replace(/^<|>$/g, ''), {
        attachmentId: part.body.attachmentId,
        mimeType,
      });
    }
  }
  for (const child of part.parts ?? []) {
    collectBodyParts(child, collector);
  }
}

export interface EmailBody {
  html: string | null;
  text: string | null;
}

// Fetches the full body of one message -- HTML (preferred) or plain text,
// with any inline (cid:) images resolved to data: URIs so they render
// without a separate network request to Gmail per image at render time.
export async function fetchEmailBody(accessToken: string, messageId: string): Promise<EmailBody> {
  const message = (await gmailFetch(`/messages/${messageId}?format=full`, accessToken)) as GmailFullMessageResponse;

  const collector: { htmlData?: string; textData?: string; inlineImages: Map<string, InlineImageRef> } = {
    inlineImages: new Map(),
  };
  if (message.payload) {
    collectBodyParts(message.payload, collector);
  }

  const text = collector.textData ? decodeBase64UrlText(collector.textData) : null;
  let html = collector.htmlData ? decodeBase64UrlText(collector.htmlData) : null;

  if (html && collector.inlineImages.size > 0) {
    const resolved = await Promise.all(
      Array.from(collector.inlineImages.entries()).map(async ([contentId, ref]) => {
        const attachment = (await gmailFetch(
          `/messages/${messageId}/attachments/${ref.attachmentId}`,
          accessToken,
        )) as { data?: string };
        const standardBase64 = base64UrlToStandard(attachment.data ?? '');
        return [contentId, `data:${ref.mimeType};base64,${standardBase64}`] as const;
      }),
    );
    for (const [contentId, dataUri] of resolved) {
      html = html.split(`cid:${contentId}`).join(dataUri);
    }
  }

  return { html, text };
}

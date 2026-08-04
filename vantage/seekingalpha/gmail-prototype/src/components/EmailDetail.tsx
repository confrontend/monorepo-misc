import { useEffect, useRef, useState } from 'react';
import { GmailAuthError, fetchEmailBody, type GmailMessageSummary } from '../gmail/gmailApi';

interface EmailDetailProps {
  email: GmailMessageSummary | null;
  accessToken: string | null;
  onAuthError: () => void;
}

function wrapHtml(html: string): string {
  const style = `
    body { font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.5;
      margin: 0; padding: 0; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
    a { color: #1a73e8; }
    table { max-width: 100%; }
  `;
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}<style>${style}</style>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${html}</body></html>`;
}

export default function EmailDetail({ email, accessToken, onAuthError }: EmailDetailProps) {
  const [body, setBody] = useState<{ html: string | null; text: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeHeight, setIframeHeight] = useState(200);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setBody(null);
    setError(null);
    setIframeHeight(200);
    if (!email || !accessToken) return;

    let cancelled = false;
    setLoading(true);
    fetchEmailBody(accessToken, email.id)
      .then((result) => {
        if (!cancelled) setBody(result);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof GmailAuthError) {
          onAuthError();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [email, accessToken, onAuthError]);

  if (!email) {
    return <p style={{ padding: 16, color: '#666', fontSize: 14 }}>Select a message to see details.</p>;
  }

  return (
    <div style={{ padding: 16 }}>
      <p style={{ fontSize: 12, color: '#999', margin: '0 0 8px' }}>Message detail</p>
      <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px', lineHeight: 1.4 }}>{email.subject}</p>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 4px' }}>
        <strong>From </strong>
        {email.from}
      </p>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 16px' }}>
        <strong>Date </strong>
        {email.date}
      </p>

      <div style={{ borderTop: '1px solid #eee', paddingTop: 12 }}>
        {loading && <p style={{ color: '#666', fontSize: 14 }}>Loading full message…</p>}
        {error && <p style={{ color: 'crimson', fontSize: 14 }}>{error}</p>}

        {!loading && !error && body?.html && (
          <iframe
            ref={iframeRef}
            title="Email body"
            srcDoc={wrapHtml(body.html)}
            // Deliberately no "allow-scripts": the email body itself stays
            // fully inert, no script in it can ever run. "allow-popups" (plus
            // "allow-popups-to-escape-sandbox") only affects whether a real,
            // user-initiated link click is allowed to open a new tab -- it
            // grants no code-execution capability. The new tab it opens is
            // an ordinary, unsandboxed tab, exactly like any normal link.
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            style={{ width: '100%', height: iframeHeight, border: 'none', display: 'block' }}
            onLoad={() => {
              const doc = iframeRef.current?.contentDocument;
              if (!doc) return;
              // Force every link to open in a new tab, regardless of what the
              // original email markup specified, so a click never navigates
              // this panel away from the app. "noopener" alone (not
              // "noreferrer") keeps the new tab from reaching back into this
              // app via window.opener, while still sending a normal referrer
              // -- a click that arrives with no referrer at all is exactly
              // the kind of signal bot-detection systems (e.g. Seeking
              // Alpha's "press and hold" challenge) treat as suspicious.
              doc.querySelectorAll('a[href]').forEach((anchor) => {
                anchor.setAttribute('target', '_blank');
                anchor.setAttribute('rel', 'noopener');
              });
              setIframeHeight(doc.documentElement.scrollHeight + 16);
            }}
          />
        )}

        {!loading && !error && !body?.html && body?.text && (
          <pre
            style={{
              fontFamily: 'inherit',
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
              margin: 0,
            }}
          >
            {body.text}
          </pre>
        )}

        {!loading && !error && body && !body.html && !body.text && (
          <p style={{ color: '#666', fontSize: 14 }}>{email.snippet || 'No readable body found for this message.'}</p>
        )}
      </div>
    </div>
  );
}

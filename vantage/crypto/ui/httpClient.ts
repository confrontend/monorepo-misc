/** Shared by App.tsx and the extracted route/hook modules. Kept out of App.tsx itself so those
 *  modules never import back into App.tsx for these two utilities -- that reverse import was
 *  the only thing making ui/App.tsx <-> ui/routes/*.tsx a circular dependency. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    /* proxy/network errors may return plain text */
  }
  if (!response.ok)
    throw new Error(body?.error ?? (text.slice(0, 240) || `Request failed (${response.status})`));
  if (!body) throw new Error('The server returned an empty or invalid response.');
  return body;
}

export const formatTime = (value: string | null): string => {
  if (!value) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month').toUpperCase()} ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
};

import type { IncomingMessage } from 'node:http';

// Same-origin polling GETs may omit Origin. Only accept that case when the
// request still targets our configured host and has same-origin browser evidence.
// WebSockets and cross-origin requests must supply the exact allowed Origin.
export function allowSocketRequest(req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, origin: string) {
  const headers = req.headers;
  if (headers.origin !== undefined) return headers.origin === origin;
  const expected = new URL(origin);
  const request = new URL(req.url ?? '/', origin);
  if (req.method !== 'GET' || request.searchParams.get('transport') !== 'polling' || headers.host !== expected.host) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin';
  // Older browsers may not send Fetch Metadata headers.
  if (!headers.referer) return false;
  try { return new URL(headers.referer).origin === expected.origin; }
  catch { return false; }
}

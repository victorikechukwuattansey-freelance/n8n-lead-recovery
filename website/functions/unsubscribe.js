// RFC 8058 one-click unsubscribe handler.
//
// POST is the action (mailbox providers POST to this URL when the user
// clicks the native "Unsubscribe" button in Gmail / Apple Mail / Yahoo).
// GET must never unsubscribe — link scanners and mail gateways follow links
// before the recipient sees them.
//
// Recipient identification: the current adapter (src/providers/resend.js)
// emits a generic URL with no per-recipient token. This handler logs the
// request so an operator can cross-reference the send log and suppress
// manually. Per-recipient HMAC tokens are a Phase 7 concern.

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.text();

  if (!body.includes('List-Unsubscribe=One-Click')) {
    return new Response('Invalid unsubscribe request', { status: 400 });
  }

  const record = {
    ts: new Date().toISOString(),
    ip: request.headers.get('cf-connecting-ip') || '',
    ua: request.headers.get('user-agent') || '',
    url: request.url,
  };

  if (env && env.UNSUB_LOGS) {
    const key = `unsub:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await env.UNSUB_LOGS.put(key, JSON.stringify(record));
  } else {
    console.log('unsubscribe (no KV bound):', JSON.stringify(record));
  }

  return new Response('Unsubscribed', { status: 200 });
}

export async function onRequestGet() {
  return new Response(
    'This endpoint accepts POST only. To unsubscribe, use the link in the email header or reply "stop".',
    { status: 200, headers: { 'Content-Type': 'text/plain' } },
  );
}
# viaaiautomation.work.gd — Public Presence

Static landing page and RFC 8058 one-click unsubscribe endpoint for the Lead Recovery Engine, deployed on Cloudflare Pages.

## What this is

A self-contained `website/` directory: a static landing page under `public/` and a Pages Function under `functions/` that handles POST `/unsubscribe`. The unsubscribe URL is emitted by the Resend adapter (`RESEND_UNSUBSCRIBE_URL`) and resolves here, closing the CAN-SPAM / RFC 8058 gap where the URL used to point nowhere.

## Local preview

```sh
npx wrangler pages dev public
```

Optional. No build step; `public/` is served as-is and `functions/` is the Functions directory.

## Deploy

See the companion operator task list for the dashboard upload flow: create a Pages project in Cloudflare, upload `public/` as the assets directory and `functions/` as the Functions directory. When asked to serve a custom domain, use `www.viaaiautomation.work.gd` (see Canonical URL).

## Environment

`UNSUB_LOGS` KV binding is optional. When bound, the unsubscribe handler writes each request to KV under an `unsub:` key. Without it, requests are logged to the Cloudflare console instead. No other environment variables are required.

## Canonical URL

`https://www.viaaiautomation.work.gd`

The Pages project serves the `www.` host, not the apex (`viaaiautomation.work.gd`). Set `RESEND_UNSUBSCRIBE_URL=https://www.viaaiautomation.work.gd/unsubscribe` in the send environment.

## Migration path

The site is portable. When a paid domain is registered, deployment becomes a CNAME change plus a global find/replace of the `viaaiautomation.work.gd` domain string in this directory, the Resend config, and `.env.example`.

## Per-recipient tokens

The current unsubscribe URL is generic — one URL for all recipients. The handler logs requests so an operator can cross-reference the send log and suppress manually. Per-recipient HMAC tokens are planned for Phase 7 and are out of scope here.
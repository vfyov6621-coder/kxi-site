/* ═══════════════════════════════════════════════════════════
   kxi chain — standalone Worker entry (fallback deploy path)

   The backend logic lives in functions/api/[[path]].js (Pages
   Functions format). This shim lets the exact same code run as
   a plain Cloudflare Worker with a D1 binding — used when the
   deploy token has Workers+D1 permissions but no Pages access.

   URL shape: https://kxi-chain-api.<account>.workers.dev/api/…
   CORS is already handled inside the shared handler.
   ═══════════════════════════════════════════════════════════ */

import { onRequest } from '../functions/api/[[path]].js';

export default {
  async fetch(request, env, ctx) {
    return onRequest({ request, env, ctx });
  }
};

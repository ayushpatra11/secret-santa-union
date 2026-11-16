// Cloudflare Worker entry point. /api/* goes to the API; everything else is a static
// file from public/ (served by Workers static assets, with the headers in public/_headers).
import { handle } from './api.js';

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return handle(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

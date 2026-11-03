// ALTCHA proof-of-work solver (PBKDF2/SHA-256 via WebCrypto), from the
// official `altcha` package (MIT). Bundled by Vite into a same-origin
// worker file, so it runs under `worker-src 'self'` — no CDN, no blob URL,
// no eval. Protocol (handled by the package): `{type: 'work', challenge,
// counterStart, counterStep, timeout}` → posts the solution or null;
// `{type: 'abort'}` stops it. Driven by app/utils/altchaSolver.ts.
import 'altcha/workers/pbkdf2'

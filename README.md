# SWU API (production-ready)

This is a small proxy API to the SWU AI chat backend. The repository includes improvements for running in production: security headers, rate limiting, request validation, logging, and environment configuration.

Setup

1. Copy `.env.example` to `.env` and fill in `SWU_USER` and `SWU_PASSWORD`.

2. Install dependencies:

```bash
npm install
```

3. Start in production:

```bash
npm run start:prod
```

Local development:

```bash
npm run dev
```

Notes

- Don't commit `.env` or `token.json` with real secrets. Use a secrets manager for production.
- Configure `CORS_ORIGIN` to the exact origin of your frontend.
- Consider running behind a reverse proxy and enabling TLS.

# Тестирование и качество

## Команды

```bash
npm test               # contracts unit + API/E2E + web typecheck
npm run typecheck      # TypeScript strict checks across workspaces
npm run build          # production build
npm run smoke          # running deployment smoke checks
npm run check          # typecheck + test
```

API Jest uses `NODE_OPTIONS=--experimental-vm-modules` because PGlite dynamically imports its WASM module inside the Jest VM. This flag is needed only for tests, not production.

## Что покрыто

### `packages/contracts` (Vitest)

- Adult baseline vs publish denial.
- Guest read-only + explicit share.
- Platform admin cannot bypass household isolation.
- Child restrictions survive `allow` override.
- Sensitive module grants and disabled modules.
- Explicit allow/deny overrides.
- Effective permission generation.

### `apps/api` (Jest + Supertest + PGlite)

A real Nest application is booted with an isolated embedded PostgreSQL database and seeded accounts. Tests cover:

- public health and public post field minimization;
- CSRF rejection and acceptance;
- session list and revoke-all;
- invitation-only registration and email verification;
- cross-household member access denial;
- platform admin denial on family data;
- guest denial on member list;
- child denial on invitations;
- owner-only module toggle;
- admin audit-chain verification;
- platform-role restriction on admin endpoints;
- password reset, old-password rejection, new-password login and session revocation.

### Frontend

- Strict TypeScript compile.
- Production Next.js build.
- Manual keyboard/responsive checks are documented in `USER-GUIDE.md`; automated browser E2E is not yet included.

## Test isolation

`test/setup.ts` sets:

```text
NODE_ENV=test
DB_DRIVER=pglite
DATABASE_URL=
PGLITE_DATA_DIR=:memory:
SEED_DEMO_DATA=true
```

Each test application creates its own PGlite instance; no shared production or developer database is touched. Sessions use deterministic development CSRF secret only in tests.

## Not yet automated

From section 33 of the TЗ, the following remain for later stages/version 1.0:

- Playwright/Cypress browser E2E scenarios on real mobile and desktop viewports;
- migration up/down tests with real PostgreSQL;
- backup restore integration test;
- SAST/DAST/dependency/security scans;
- accessibility audit with axe and screen readers;
- RU/IT snapshot tests for every screen;
- PWA install and Web Push device tests;
- queue retry/idempotency tests;
- AI forbidden-data tests;
- WebRTC/TURN network/load tests;
- realtime/Yjs conflict tests;
- 6–10 user load and VPS resource tests.

These gaps are intentional and documented; Stage A is not claimed as version 1.0.

## Definition of Done for future modules

Every module from stages B–H must add:

1. API tests for all accepted scenarios;
2. role and cross-space isolation tests;
3. server-side permission assertions;
4. error and empty states;
5. audit records;
6. RU/IT strings;
7. responsive and accessibility checks;
8. export/backup participation;
9. docs;
10. VPS resource/security review.

# Web: XiaoMei ERP screens (Next.js)

The screens staff use: Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui, on port **3000** of the shop computer, next to the Express API (`../Backend`, port **5000**).

**UI only.** No API routes, Server Actions, middleware, database or secrets. The browser calls Express directly (Bearer token, one Socket.io connection per tab). Every rule (permissions, money, stock, statuses) is decided by the API; the screens show what it returns. See `../docs/nextjs-migration-steering.md`.

## Run it

For the shop, use the start-up script in `../scripts/` (it starts the API too). See the main `../README.md` Quick start.

By hand (the API must be running):

```bash
npm ci
npm run build && npm run start    # production, http://0.0.0.0:3000
npm run dev                       # development with hot reload
```

The API address is worked out in the browser at run time: `http://<same host>:5000/api`, so one build works on every branch and on tablets (`http://<shop-computer-ip>:3000`). Set `NEXT_PUBLIC_API_URL` only if the API is somewhere else. Every address the screens are opened from must be in `CORS_ORIGINS` in `../Backend/.env`.

`next.config.ts` refuses to build or start if `DATABASE_URL`, `PG_LISTEN_URL`, `JWT_SECRET` or `TEST_DATABASE_URL` are in the environment.

## Checks (same as CI)

```bash
npm run check-rules        # rules guard: no business rules, role checks, backend imports, remote assets…
npm run check-rules:test   # tests for the guard itself
npm run lint
npm run typecheck
npm run build
```

`node scripts/check-rules.mjs --list` prints every guard rule. Shared non-UI code lives in `../shared/client-core` (`npm test` there).

If the project folder's name contains a semicolon, `npm run` cannot find `next` / `eslint` on Windows (the semicolon splits PATH). Use a folder name without one, or run the tools directly, e.g. `node node_modules/next/dist/bin/next build`.

## Layout

```
app/login/                 sign in
app/(app)/                 everything behind login (shell: header, connection bar, socket)
  dashboard/  catalog/  orders/  orders/new/  accounts/
components/                one folder per section; feedback/ = ResultDialog, ConfirmDialog; ui/ = shadcn
hooks/                     useApi, useSession, useSocketEvent, useFallbackPolling, …
lib/ui-tokens.ts           the one place that maps server states to colours, labels and icons
```

Per-screen porting audits: `../docs/migration/`.

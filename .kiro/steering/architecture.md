---
inclusion: always
---

# XiaoWuSys: standing architecture rules

- The current frontend (Vite + React + inline styles) is the **MVP/Beta**. At the end of the project it will be migrated to **Next.js + Tailwind CSS** and a **mobile app**. The Express + Neon + Socket.io + SQLite backend and its API stay.
- Keep business logic decoupled from the UI so that migration is mechanical:
  - Rules live on the server, in `Backend/services/`; pure rules go in `services/domain/`. Routes stay thin.
  - The API returns derived decisions (`allowed_actions`, `capabilities`, `payment_status`, `stock_check`, `stock_status`, ...). Clients never re-implement rules.
  - Frontend non-UI code (API client, socket client, connection watcher, formatters) goes in `Frontend/src/lib/`, with no React or DOM imports.
  - Visual states come from status tokens mapped to styles in one place per component.
- Until the migration, styling stays React inline styles (no Tailwind, no UI libraries; `lucide-react` only).
- Full plan and sprint context: `XiaoWuSys-main/docs/sprint-12-steering.md` (§3).

# Porting audit: Accounts (Batch M4)

Steering: `docs/nextjs-migration-steering.md` §3.4.
Source: `Frontend/src/UsersPage.jsx` (frozen Vite MVP). The change-password dialog was ported in M1 (`Web/components/account/change-password-dialog.tsx`, opened from `AppHeader`) and is not duplicated here.
Target: `Web/app/(app)/accounts/page.tsx` (wrapped in `<RequireCapability capability="manage_accounts">`) → `Web/components/accounts/accounts-screen.tsx`.
API (`Backend/routes/auth.js`): `GET /api/auth/users` → `{ source, users, assignable_roles }`; `POST /api/auth/register`; `PATCH /api/auth/users/:user_id` (`{ role }` or `{ is_active }`); `POST /api/auth/users/:user_id/reset-password` (`{ new_password }`). All are `requireRole(MANAGER_ROLES)`. Writes are online only.

Categories: **1. Presentation** (port freely) · **2. Formatting** (must call client-core) · **3. Rule** (must already be an API field; must not exist in `Web/`).

**Result: no category-3 logic lives in `Web/`.** The MVP's two role-string rules and its password-strength check were replaced by server answers. `npm run check-rules` passes.

## 1. Permissions and "who may manage whom"

| MVP expression | Category | In `Web/` |
|---|---|---|
| `canManage(u) = u.user_id !== currentUser?.user_id && (u.role !== 'Owner' \|\| currentUser?.role === 'Owner')` | **3** | **Removed.** `a.user_id !== me?.user_id && assignable.includes(a.role)`. `assignable_roles` comes from the server's `allowedRolesFor(req.user.role)`, which includes Owner only for an Owner. The server re-checks every PATCH and reset |
| Role options `data.assignable_roles.length ? ... : ['Admin', 'Production', 'Staff']` | **3** | **Removed.** Options are `data.assignable_roles` only. No role names are hard-coded in `Web/` |
| Row role select: `[...new Set([...assignable_roles, x.role])]` | 1 | Same (keeps the row's current role visible) |
| `EMPTY_NEW.role = 'Staff'` default | 3 (role literal) | No default. The person must choose from `assignable_roles` ("Choose a role…") |
| Page shown to whoever opens the tab (App.jsx hid the tab by role) | 1 | `RequireCapability capability="manage_accounts"` + hidden nav link; Express answers 403 anyway |

## 2. Offline / read-only

| MVP expression | Category | In `Web/` |
|---|---|---|
| `offline = data.source === 'local'` | 1 (server's answer) | `list.source === 'local'` **or** the connection state (from `/api/sync/status`) is `offline_local` / `server_down`. Write buttons are disabled and the warning banner shows. The server still returns `503 ACCOUNTS_REQUIRE_CLOUD` if anything slips through |
| Create button `disabled={busy \|\| offline}` | 1 | "New account" disabled while offline or before the list loads |

## 3. Forms

| MVP expression | Category | In `Web/` |
|---|---|---|
| `passwordHint()` / `passwordOk()`: 8+ characters, a letter and a number, blocking submit | **3** (duplicated server limit, §3.1) | **Removed.** Static hint "At least 8 characters, with a letter and a number." The server decides (`400 VALIDATION_FAILED` with a plain-words reason) and its message is shown in a `ResultDialog` |
| Username `.replace(/\s/g, '')`, `maxLength={100}` | 1 (input format) | Same; `maxLength` from `Web/lib/input-limits.ts` (`TEXT_MAX.username`) |
| Password `maxLength={72}` | 1 (input format) | `TEXT_MAX.password` |
| `ROLE_HELP` object in the screen | 2 | `roleHelp(role)` from `@xiaowu/client-core/permissions` (display text keyed by the server's role names; unknown role → generic hint) |
| `username.trim()` before POST | 1 | Same |

## 4. Outcomes

| MVP expression | Category | In `Web/` |
|---|---|---|
| `report(ok, body, title, fallback)` → `ResultDialog`; reload on success | 1 | Same for role change and activate/deactivate |
| Create / reset: refusal → `ResultDialog`, form stays open | 1 | Same: `onResult` shows the server's message in the screen's `ResultDialog` and keeps the form and its input. Success closes the form, shows a `ResultDialog` and reloads |
| Deactivate / reactivate `ConfirmDialog` | 1 | `ConfirmDialog` (shadcn `AlertDialog`), destructive styling for Deactivate |
| `errorText(body, fallback)` | 2 | `errorMessage()` (wraps client-core `errorText`) |

## 5. Display

| MVP expression | Category | In `Web/` |
|---|---|---|
| "you" badge when `x.user_id === currentUser?.user_id` | 1 (identity, not role) | Same |
| Active / Deactivated pill colours | 1 | `TONE_CLASSES.success` / `TONE_CLASSES.muted` from `ui-tokens.ts` |
| `formatDateTime(x.created_at, { withTime: false, utc: true })` | 2 | Same client-core call |
| Own row: "Use 'Change password' at the top" | 1 | "Use 'Change my password' in your account menu" (the M1 dialog's location) |

## 6. Checked by hand vs not

- Checked by reading the code: no role-name comparison and no quoted role literal in `Web/` (`no-role-checks` passes). Row actions follow `assignable_roles` + `user_id` only.
- Decision flip (by reading the code): if the server adds `Owner` to `assignable_roles`, Owner rows become manageable and `Owner` appears in the role options. With `source: 'local'`, all writes disable.
- **Not** checked in a browser in this batch: see `docs/migration/m5-parity-signoff.md`. Test it with an **Admin** account specifically: Owner rows must show "—".

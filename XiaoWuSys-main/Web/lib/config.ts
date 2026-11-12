// Where the shop server lives, resolved in the browser at run time (N1, N3, Q4).
// Call these only from client code: on the Next.js server there is no page address to follow.
import { resolveApiBase, socketUrlFor } from '@xiaowu/client-core/config';

// Optional fixed address, e.g. when the API runs on a different computer. Leave unset normally.
const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL;

export const apiBase = (): string => resolveApiBase({ configured: CONFIGURED_API_URL });

export const socketUrl = (): string => socketUrlFor(apiBase());

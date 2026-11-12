export const DEFAULT_API_PORT: number;

export function resolveApiBase(options?: {
  configured?: string;
  location?: { protocol: string; hostname: string } | null;
  port?: number;
}): string;

export function socketUrlFor(apiBase: string): string;

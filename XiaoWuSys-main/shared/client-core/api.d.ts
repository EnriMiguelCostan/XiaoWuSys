// Types for api.js. The server decides; these only describe the envelope the client receives.
export interface ApiResult<T = ApiBody> {
  ok: boolean;
  /** HTTP status, or 0 when the shop server could not be reached */
  status: number;
  data: T;
}

/** Structured error body: { error: 'MACHINE_CODE', message: 'Plain sentence', ...details } */
export interface ApiBody {
  error?: string;
  message?: string;
  /** 'cloud' | 'local': which database answered */
  source?: 'cloud' | 'local';
  [key: string]: unknown;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiCall = <T = ApiBody>(method: HttpMethod, path: string, body?: unknown) => Promise<ApiResult<T>>;

export function createApi(options: { apiBase: string; token: string; onUnauthorized?: () => void }): ApiCall;

export const FRIENDLY_ERRORS: Readonly<Record<string, string>>;

export function errorText(data: ApiBody | null | undefined, fallback: string): string;

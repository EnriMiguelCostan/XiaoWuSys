export function todayInManila(): string;
export const MOBILE_PATTERN: RegExp;
export function peso(n: number | string | null | undefined): string;
export function formatDateTime(value: string | null | undefined, options?: { withTime?: boolean; utc?: boolean }): string;
/** '09171234567' -> '0917 123 4567' for display (Miller's law chunking). Other text is returned as stored. */
export function formatMobile(value: string | null | undefined): string;

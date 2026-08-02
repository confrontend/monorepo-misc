export const DEBUG = import.meta.env.VITE_DEBUG === "true";

export function debugLog(label: string, payload?: unknown): void {
  if (!DEBUG) return;
  if (payload === undefined) {
    console.debug(`[debug] ${label}`);
  } else {
    console.debug(`[debug] ${label}`, payload);
  }
}

export function debugError(label: string, payload?: unknown): void {
  if (!DEBUG) return;
  if (payload === undefined) {
    console.error(`[debug] ${label}`);
  } else {
    console.error(`[debug] ${label}`, payload);
  }
}

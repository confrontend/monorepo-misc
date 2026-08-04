export const DEBUG = import.meta.env.VITE_DEBUG === "true";

function writeDiagnosticFile(label: string, payload?: unknown): void {
  // Browsers cannot append to a project file directly. In dev mode this
  // forwards the same diagnostic event to the backend's temporary log file.
  void fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, payload }),
  }).catch(() => undefined);
}

export function debugLog(label: string, payload?: unknown): void {
  if (!DEBUG) return;
  writeDiagnosticFile(label, payload);
  if (payload === undefined) {
    console.debug(`[debug] ${label}`);
  } else {
    console.debug(`[debug] ${label}`, payload);
  }
}

export function debugError(label: string, payload?: unknown): void {
  if (!DEBUG) return;
  writeDiagnosticFile(label, payload);
  if (payload === undefined) {
    console.error(`[debug] ${label}`);
  } else {
    console.error(`[debug] ${label}`, payload);
  }
}

export type DebugEntry = {
  id: number;
  ts: number;
  level: "info" | "warn" | "error" | "success";
  scope: string;
  message: string;
  data?: unknown;
};

type Listener = (entries: DebugEntry[]) => void;

let entries: DebugEntry[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

export function logDebug(
  level: DebugEntry["level"],
  scope: string,
  message: string,
  data?: unknown,
) {
  const entry: DebugEntry = {
    id: nextId++,
    ts: Date.now(),
    level,
    scope,
    message,
    data,
  };
  entries = [...entries, entry].slice(-500);
  listeners.forEach((l) => l(entries));
  // Also mirror to console for devtools
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn(`[${scope}] ${message}`, data ?? "");
}

export function getDebugEntries(): DebugEntry[] {
  return entries;
}

export function clearDebug() {
  entries = [];
  listeners.forEach((l) => l(entries));
}

export function subscribeDebug(l: Listener): () => void {
  listeners.add(l);
  l(entries);
  return () => {
    listeners.delete(l);
  };
}

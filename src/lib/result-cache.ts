// Cache local (localStorage) de resultados da prospecção.
// Chave: `${ibgeId}|${YYYY-MM-DD}` — uma entrada por município por dia.
// Evita repetir consultas caras ao Firecrawl, ao site da prefeitura e ao Querido Diário
// quando o usuário roda a mesma busca várias vezes no mesmo dia.

import type { ProspectResult } from "./prospect.types";

const STORAGE_KEY = "municipia:result-cache:v1";
const MAX_ENTRIES = 200;
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

export type CachedEntry = {
  key: string;            // `${ibgeId}|${YYYY-MM-DD}`
  ibgeId: number;
  municipio: string;
  uf: string;
  date: string;           // YYYY-MM-DD
  savedAt: number;        // epoch ms
  result: ProspectResult;
};

type Store = Record<string, CachedEntry>;

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function cacheKey(ibgeId: number, date: string = today()): string {
  return `${ibgeId}|${date}`;
}

function readStore(): Store {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  if (!isBrowser()) return;
  try {
    // Limpa entradas expiradas e respeita o limite máximo (LRU por savedAt).
    const now = Date.now();
    const entries = Object.values(store)
      .filter((e) => now - e.savedAt < TTL_MS)
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, MAX_ENTRIES);
    const clean: Store = {};
    for (const e of entries) clean[e.key] = e;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // quota cheia: limpa tudo e tenta de novo
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }
}

export function getCached(ibgeId: number): CachedEntry | null {
  const store = readStore();
  const entry = store[cacheKey(ibgeId)];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TTL_MS) return null;
  return entry;
}

export function setCached(
  ibgeId: number,
  municipio: string,
  uf: string,
  result: ProspectResult,
): CachedEntry {
  const store = readStore();
  const date = today();
  const entry: CachedEntry = {
    key: cacheKey(ibgeId, date),
    ibgeId,
    municipio,
    uf,
    date,
    savedAt: Date.now(),
    result,
  };
  store[entry.key] = entry;
  writeStore(store);
  return entry;
}

export function listCached(): CachedEntry[] {
  return Object.values(readStore()).sort((a, b) => b.savedAt - a.savedAt);
}

export function clearCache() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

export function invalidate(ibgeId: number) {
  const store = readStore();
  delete store[cacheKey(ibgeId)];
  writeStore(store);
}

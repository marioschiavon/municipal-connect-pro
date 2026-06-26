import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Search, Trash2, Building2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MunicipioCombobox } from "@/components/MunicipioCombobox";
import { ResultCard, type CardState } from "@/components/ResultCard";
import { ExportButtons } from "@/components/ExportButtons";
import type { Municipio } from "@/lib/ibge";
import type { ProgressEvent, ProspectResult } from "@/lib/prospect.types";
import { logDebug } from "@/lib/debug-log";
import { APP_VERSION } from "@/lib/version";
import { getCached, setCached, clearCache, listCached } from "@/lib/result-cache";
import type { ExportRow } from "@/lib/export";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MunicipIA — Coleta inteligente de contatos municipais" },
      {
        name: "description",
        content:
          "Prospecção automatizada de contatos das Secretarias de Educação municipais brasileiras com fallback hierárquico.",
      },
      { property: "og:title", content: "MunicipIA" },
      {
        property: "og:description",
        content: "Coleta inteligente de contatos municipais.",
      },
    ],
  }),
  component: Index,
});

const MAX = 5;

type RunningCard = {
  key: string;
  municipio: string;
  uf: string;
  state: CardState;
  slow: boolean;
};

async function streamProspect(
  municipio: string,
  uf: string,
  ibgeId: number,
  useDiario: boolean,
  signal: AbortSignal,
  onEvent: (evt: ProgressEvent) => void,
): Promise<ProspectResult | null> {
  const res = await fetch("/api/prospect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ municipio, uf, ibgeId, useDiario }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final: ProspectResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as ProgressEvent;
        onEvent(evt);
        if (evt.kind === "final") final = evt.result;
      } catch (e) {
        console.warn("Falha parse linha NDJSON", trimmed, e);
      }
    }
  }
  return final;
}

function Index() {
  const [selected, setSelected] = useState<Municipio[]>([]);
  const [cards, setCards] = useState<RunningCard[]>([]);
  const [running, setRunning] = useState(false);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [useDiario, setUseDiario] = useState(false);
  const [cacheCount, setCacheCount] = useState(0);

  const slowTimers = useRef<Record<string, number>>({});
  const abortRef = useRef<AbortController | null>(null);
  const canceledRef = useRef(false);

  useEffect(() => {
    setCacheCount(listCached().length);
  }, []);

  useEffect(() => {
    return () => {
      Object.values(slowTimers.current).forEach((t) => window.clearTimeout(t));
      abortRef.current?.abort();
    };
  }, []);

  function addSelected(m: Municipio) {
    if (selected.length >= MAX) return;
    if (selected.some((s) => s.id === m.id)) return;
    setSelected((s) => [...s, m]);
  }

  function removeSelected(id: number) {
    setSelected((s) => s.filter((m) => m.id !== id));
  }

  function clearAll() {
    setSelected([]);
    setCards([]);
  }

  function patchCard(key: string, fn: (c: RunningCard) => RunningCard) {
    setCards((prev) => prev.map((c) => (c.key === key ? fn(c) : c)));
  }

  function cancelSearch() {
    if (!running) return;
    canceledRef.current = true;
    abortRef.current?.abort();
    logDebug("warn", "prospect", "Busca cancelada pelo usuário");
  }

  async function startSearch() {
    if (selected.length === 0 || running) return;
    canceledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    const initial: RunningCard[] = selected.map((m) => ({
      key: `${m.id}`,
      municipio: m.nome,
      uf: m.uf,
      state: { phase: "searching", events: [] },
      slow: false,
    }));
    setCards(initial);

    for (const m of selected) {
      const key = `${m.id}`;
      const scope = `prospect:${m.nome}/${m.uf}`;

      if (canceledRef.current) {
        patchCard(key, (c) =>
          c.state.phase === "done" || c.state.phase === "error"
            ? c
            : { ...c, state: { phase: "canceled", events: c.state.events }, slow: false },
        );
        continue;
      }

      // === CACHE: tentar servir do localStorage antes de bater na rede ===
      if (!forceRefresh) {
        const cached = getCached(m.id);
        if (cached) {
          const ageMin = Math.round((Date.now() - cached.savedAt) / 60000);
          const cacheEvt: ProgressEvent = {
            kind: "progress",
            level: "success",
            etapa: "init",
            message: `Cache local: resultado de ${cached.date} (há ${ageMin} min) — sem nova consulta`,
            data: { savedAt: cached.savedAt },
            ts: Date.now(),
          };
          const finalEvt: ProgressEvent = {
            kind: "final",
            result: cached.result,
            ts: Date.now(),
          };
          logDebug("success", scope, cacheEvt.message);
          patchCard(key, (c) => ({
            ...c,
            state: {
              phase: "done",
              result: cached.result,
              events: [...c.state.events, cacheEvt, finalEvt],
            },
            slow: false,
          }));
          continue;
        }
      }

      slowTimers.current[key] = window.setTimeout(() => {
        patchCard(key, (c) => ({ ...c, slow: true }));
      }, 45000);

      try {
        const result = await streamProspect(m.nome, m.uf, m.id, useDiario, controller.signal, (evt) => {
          if (evt.kind === "progress") {
            logDebug(evt.level, scope, evt.message, evt.data);
            patchCard(key, (c) => {
              const events = [...c.state.events, evt];
              const phase =
                c.state.phase === "searching" && evt.etapa !== "init"
                  ? ("analyzing" as const)
                  : c.state.phase;
              if (phase === "searching" || phase === "analyzing") {
                return { ...c, state: { phase, events } };
              }
              return { ...c, state: { ...c.state, events } };
            });
          } else {
            logDebug(
              evt.result.status === "found"
                ? "success"
                : evt.result.status === "partial"
                  ? "warn"
                  : "error",
              scope,
              `Final: ${evt.result.status} (${evt.result.fonte ?? "—"})`,
              evt.result,
            );
            // Salva no cache local (somente resultados não-vazios)
            if (evt.result.status !== "not_found") {
              try {
                setCached(m.id, m.nome, m.uf, evt.result);
                setCacheCount(listCached().length);
              } catch (e) {
                console.warn("Falha ao salvar cache", e);
              }
            }
            patchCard(key, (c) => ({
              ...c,
              state: { phase: "done", result: evt.result, events: [...c.state.events, evt] },
              slow: false,
            }));
          }
        });
        if (!result && !canceledRef.current) {
          patchCard(key, (c) =>
            c.state.phase === "done"
              ? c
              : {
                  ...c,
                  state: { phase: "error", error: "Sem resposta final do servidor", events: c.state.events },
                  slow: false,
                },
          );
        }
      } catch (err) {
        const aborted =
          canceledRef.current ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && /abort/i.test(err.message));
        if (aborted) {
          logDebug("warn", scope, "Busca interrompida");
          patchCard(key, (c) =>
            c.state.phase === "done"
              ? c
              : { ...c, state: { phase: "canceled", events: c.state.events }, slow: false },
          );
        } else {
          const message = err instanceof Error ? err.message : "Falha ao buscar";
          logDebug("error", scope, "Falha no stream", message);
          patchCard(key, (c) => ({
            ...c,
            state: { phase: "error", error: message, events: c.state.events },
            slow: false,
          }));
        }
      } finally {
        window.clearTimeout(slowTimers.current[key]);
      }
    }

    abortRef.current = null;
    setRunning(false);
  }

  const exportRows: ExportRow[] = cards
    .filter((c) => c.state.phase === "done")
    .map((c) => ({
      municipio: c.municipio,
      uf: c.uf,
      result: (c.state as { phase: "done"; result: ProspectResult }).result,
      buscadoEm: new Date().toLocaleString("pt-BR"),
    }));

  const atLimit = selected.length >= MAX;

  return (
    <div className="min-h-screen bg-white text-foreground">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-7xl items-start justify-between px-6 py-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight">MunicipIA</h1>
              <Link
                to="/debug"
                title="Abrir tela de debug"
                aria-label="Abrir debug (secreto)"
                className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 transition hover:border-amber-300 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                {APP_VERSION}
              </Link>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Coleta inteligente de contatos municipais
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-8 md:grid-cols-[minmax(280px,30%)_1fr]">
        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-white p-5">
            <label className="text-sm font-medium text-foreground">
              Adicionar município
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Máximo de {MAX} municípios por busca
            </p>
            <div className="mt-3">
              <MunicipioCombobox
                onSelect={addSelected}
                disabled={atLimit || running}
                selectedIds={selected.map((s) => s.id)}
              />
            </div>
            {atLimit && (
              <p className="mt-2 text-xs text-amber-700">
                Limite de {MAX} municípios atingido. Remova um para adicionar outro.
              </p>
            )}

            {selected.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {selected.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between rounded-md border border-border bg-gray-50 px-3 py-2 text-sm"
                  >
                    <span>
                      <span className="font-medium">{m.nome}</span>{" "}
                      <span className="text-muted-foreground">— {m.uf}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSelected(m.id)}
                      disabled={running}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                      aria-label={`Remover ${m.nome}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex flex-col gap-2">
              {running ? (
                <Button
                  onClick={cancelSearch}
                  variant="destructive"
                  className="w-full"
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancelar busca
                </Button>
              ) : (
                <Button
                  onClick={startSearch}
                  disabled={selected.length === 0}
                  className="w-full"
                >
                  <Search className="mr-2 h-4 w-4" />
                  Iniciar busca
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={clearAll}
                disabled={running || (selected.length === 0 && cards.length === 0)}
                className="w-full"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Limpar tudo
              </Button>
            </div>

            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-700">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={forceRefresh}
                  onChange={(e) => setForceRefresh(e.target.checked)}
                  disabled={running}
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer"
                />
                <span>
                  <span className="font-medium">Forçar nova busca</span>
                  <span className="block text-[11px] text-slate-500">
                    Ignora o cache local e refaz tudo, mesmo que já tenha buscado hoje.
                  </span>
                </span>
              </label>
              <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-slate-200 pt-2">
                <input
                  type="checkbox"
                  checked={useDiario}
                  onChange={(e) => setUseDiario(e.target.checked)}
                  disabled={running}
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer"
                />
                <span>
                  <span className="font-medium">Consultar Diário Oficial</span>
                  <span className="block text-[11px] text-slate-500">
                    Querido Diário (mais lento, ~2s extra). Útil em cidades com pouca info no Google.
                  </span>
                </span>
              </label>

              <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                <span>
                  {cacheCount > 0
                    ? `${cacheCount} resultado(s) em cache (24h)`
                    : "Cache vazio"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearCache();
                    setCacheCount(0);
                  }}
                  disabled={running || cacheCount === 0}
                  className="text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  Limpar cache
                </button>
              </div>
            </div>

          </div>

          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-4 text-xs leading-relaxed text-slate-600">
            <p className="font-semibold text-slate-700">Como o robô procura (escalonado)</p>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
              <li><b>A.</b> Descobre o <b>nome</b> do(a) Secretário(a) — site oficial + Querido Diário</li>
              <li><b>B.</b> Com o nome em mãos, faz <b>novas buscas</b> atrás de e-mail/telefone dessa pessoa</li>
              <li><b>C.</b> Contato institucional da Secretaria de Educação (fallback)</li>
              <li><b>D.</b> Último recurso: contato geral da prefeitura → gabinete do prefeito</li>
            </ol>
            <p className="mt-2 text-[11px] text-slate-500">
              💾 Resultados ficam em <b>cache local</b> por 24h por município — repetir a mesma busca no mesmo dia é instantâneo.
            </p>
          </div>

        </aside>

        <section className="space-y-4">
          {cards.length === 0 ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-white p-10 text-center">
              <div className="rounded-full bg-gray-50 p-4">
                <Building2 className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-base font-semibold text-foreground">
                Nenhuma busca iniciada
              </h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Selecione até {MAX} municípios brasileiros à esquerda e clique em
                <span className="font-medium"> "Iniciar busca"</span> para coletar os
                contatos das Secretarias de Educação.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {cards.map((c) => (
                  <ResultCard
                    key={c.key}
                    municipio={c.municipio}
                    uf={c.uf}
                    state={c.state}
                    slow={c.slow}
                  />
                ))}
              </div>

              <div className="rounded-lg border border-border bg-white p-4">
                <ExportButtons rows={exportRows} disabled={running} />
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="mt-12 border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-5 text-center text-[11px] text-muted-foreground">
          Powered by Leaderei · Desenvolvido por S7
        </div>
      </footer>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Search, Trash2, Building2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MunicipioCombobox } from "@/components/MunicipioCombobox";
import { ResultCard, type CardState } from "@/components/ResultCard";
import { ExportButtons } from "@/components/ExportButtons";
import type { Municipio } from "@/lib/ibge";
import type { ProspectResult } from "@/lib/prospect.types";
import { prospectarMunicipio } from "@/lib/prospect.functions";
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

function Index() {
  const [selected, setSelected] = useState<Municipio[]>([]);
  const [cards, setCards] = useState<RunningCard[]>([]);
  const [running, setRunning] = useState(false);
  const prospect = useServerFn(prospectarMunicipio);
  const slowTimers = useRef<Record<string, number>>({});
  const phaseTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      Object.values(slowTimers.current).forEach((t) => window.clearTimeout(t));
      Object.values(phaseTimers.current).forEach((t) => window.clearTimeout(t));
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

  function patchCard(key: string, patch: Partial<RunningCard>) {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  async function startSearch() {
    if (selected.length === 0 || running) return;
    setRunning(true);
    const initial: RunningCard[] = selected.map((m) => ({
      key: `${m.id}`,
      municipio: m.nome,
      uf: m.uf,
      state: { phase: "searching" as const },
      slow: false,
    }));
    setCards(initial);

    for (const m of selected) {
      const key = `${m.id}`;
      // Slow warning after 30s
      slowTimers.current[key] = window.setTimeout(() => {
        setCards((prev) => prev.map((c) => (c.key === key ? { ...c, slow: true } : c)));
      }, 30000);
      // Switch to "Analisando..." after 3.5s
      phaseTimers.current[key] = window.setTimeout(() => {
        setCards((prev) =>
          prev.map((c) =>
            c.key === key && c.state.phase === "searching"
              ? { ...c, state: { phase: "analyzing" } }
              : c,
          ),
        );
      }, 3500);

      try {
        const result = (await prospect({ data: { municipio: m.nome, uf: m.uf } })) as ProspectResult;
        patchCard(key, { state: { phase: "done", result }, slow: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Falha ao buscar";
        patchCard(key, { state: { phase: "error", error: message }, slow: false });
      } finally {
        window.clearTimeout(slowTimers.current[key]);
        window.clearTimeout(phaseTimers.current[key]);
      }
    }

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
      {/* Header */}
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-7xl items-start justify-between px-6 py-5">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight">MunicipIA</h1>
              <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Alpha v0.1
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Coleta inteligente de contatos municipais
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-8 md:grid-cols-[minmax(280px,30%)_1fr]">
        {/* Coluna esquerda */}
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
              <Button
                onClick={startSearch}
                disabled={selected.length === 0 || running}
                className="w-full"
              >
                <Search className="mr-2 h-4 w-4" />
                {running ? "Buscando..." : "Iniciar busca"}
              </Button>
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
          </div>
        </aside>

        {/* Área central */}
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

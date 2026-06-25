import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  subscribeDebug,
  clearDebug,
  logDebug,
  type DebugEntry,
} from "@/lib/debug-log";
import { loadMunicipios } from "@/lib/ibge";

export const Route = createFileRoute("/debug")({
  head: () => ({
    meta: [{ title: "Debug — MunicipIA" }, { name: "robots", content: "noindex" }],
  }),
  component: DebugPage,
});

const levelStyles: Record<DebugEntry["level"], string> = {
  info: "bg-slate-100 text-slate-700 border-slate-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
};

function DebugPage() {
  const [entries, setEntries] = useState<DebugEntry[]>([]);

  useEffect(() => subscribeDebug(setEntries), []);

  async function reload() {
    logDebug("info", "debug", "Recarregando lista de municípios (forçado)");
    try {
      await loadMunicipios();
    } catch (e) {
      logDebug("error", "debug", "Falha no reload", String(e));
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-foreground">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-lg font-semibold">Debug · MunicipIA</h1>
            <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-mono uppercase text-slate-600">
              {entries.length} eventos
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={reload}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Recarregar IBGE
            </Button>
            <Button size="sm" variant="ghost" onClick={clearDebug}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Limpar
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white p-10 text-center text-sm text-muted-foreground">
            Nenhum evento ainda. Volte à página inicial e digite no autocomplete
            para gerar logs.
          </div>
        ) : (
          <ol className="space-y-1.5 font-mono text-xs">
            {[...entries].reverse().map((e) => (
              <li
                key={e.id}
                className={`rounded border p-2.5 ${levelStyles[e.level]}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] opacity-60">
                    {new Date(e.ts).toLocaleTimeString("pt-BR", {
                      hour12: false,
                    })}
                  </span>
                  <span className="rounded bg-white/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                    {e.level}
                  </span>
                  <span className="text-[10px] opacity-70">[{e.scope}]</span>
                  <span className="text-[12px]">{e.message}</span>
                </div>
                {e.data !== undefined && (
                  <pre className="mt-1.5 max-h-60 overflow-auto rounded bg-white/70 p-2 text-[11px] leading-tight">
                    {(() => {
                      try {
                        return JSON.stringify(e.data, null, 2);
                      } catch {
                        return String(e.data);
                      }
                    })()}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </main>
    </div>
  );
}

import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Mail,
  Phone,
  User,
  Briefcase,
  Clock,
  Search,
  Globe,
  Brain,
  ArrowRightCircle,
} from "lucide-react";
import type { ProspectResult, Hierarquia, ProgressEvent } from "@/lib/prospect.types";

export type CardState =
  | { phase: "searching"; events: ProgressEvent[] }
  | { phase: "analyzing"; events: ProgressEvent[] }
  | { phase: "done"; result: ProspectResult; events: ProgressEvent[] }
  | { phase: "error"; error: string; events: ProgressEvent[] };

type Props = {
  municipio: string;
  uf: string;
  state: CardState;
  slow: boolean;
};

const hierBadge: Record<Hierarquia, { label: string; cls: string; dot: string }> = {
  educacao: {
    label: "Contato direto da Educação",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  geral: {
    label: "Contato geral da prefeitura (fallback)",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    dot: "bg-amber-500",
  },
  gabinete: {
    label: "Gabinete do prefeito (último recurso)",
    cls: "bg-sky-50 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
  },
};

function StatusPill({ state }: { state: CardState }) {
  if (state.phase === "searching")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
        <Loader2 className="h-3 w-3 animate-spin" /> Buscando...
      </span>
    );
  if (state.phase === "analyzing")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
        <Loader2 className="h-3 w-3 animate-spin" /> Analisando...
      </span>
    );
  if (state.phase === "error")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
        <XCircle className="h-3 w-3" /> Erro
      </span>
    );
  const r = state.result;
  if (r.status === "found")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Concluído
      </span>
    );
  if (r.status === "partial")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
        <AlertTriangle className="h-3 w-3" /> Parcial
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
      <XCircle className="h-3 w-3" /> Não encontrado
    </span>
  );
}

function eventIcon(evt: Extract<ProgressEvent, { kind: "progress" }>) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (evt.level === "error") return <XCircle className={`${cls} text-red-600`} />;
  if (evt.level === "warn") return <AlertTriangle className={`${cls} text-amber-600`} />;
  if (evt.level === "success") return <CheckCircle2 className={`${cls} text-emerald-600`} />;
  const m = evt.message.toLowerCase();
  if (m.includes("pesquisando") || m.includes("buscador") || m.includes("resultado"))
    return <Search className={`${cls} text-slate-500`} />;
  if (m.includes("lendo") || m.includes("scrape") || m.includes("página"))
    return <Globe className={`${cls} text-slate-500`} />;
  if (m.includes("ia ") || m.includes("extrair") || m.includes("ia.")) return <Brain className={`${cls} text-slate-500`} />;
  if (m.startsWith("etapa") || m.includes("fallback"))
    return <ArrowRightCircle className={`${cls} text-slate-500`} />;
  return <Loader2 className={`${cls} text-slate-400`} />;
}

function Timeline({ events, live }: { events: ProgressEvent[]; live: boolean }) {
  const progress = events.filter((e): e is Extract<ProgressEvent, { kind: "progress" }> => e.kind === "progress");
  if (progress.length === 0) return null;

  if (live) {
    const last = progress[progress.length - 1];
    return (
      <div className="mt-3 flex items-center gap-2 text-xs leading-snug text-slate-700 transition-all">
        <span>{eventIcon(last)}</span>
        <span className="flex-1 truncate" title={last.message}>{last.message}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {progress.length} {progress.length === 1 ? "passo" : "passos"}
        </span>
      </div>
    );
  }

  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Ver os {progress.length} passos da busca
      </summary>
      <ol className="mt-2 space-y-1.5 border-l-2 border-slate-100 pl-3">
        {progress.map((e, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-snug text-slate-700">
            <span className="mt-0.5">{eventIcon(e)}</span>
            <span className="flex-1">{e.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}


export function ResultCard({ municipio, uf, state, slow }: Props) {
  const result = state.phase === "done" ? state.result : null;
  const hier = result?.hierarquia ? hierBadge[result.hierarquia] : null;
  const live = state.phase === "searching" || state.phase === "analyzing";

  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {municipio} <span className="text-muted-foreground">— {uf}</span>
          </h3>
          {hier && (
            <span
              className={`mt-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${hier.cls}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${hier.dot}`} />
              {hier.label}
            </span>
          )}
        </div>
        <StatusPill state={state} />
      </div>

      {slow && live && (
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-700">
          <Clock className="h-3 w-3" /> Levando mais tempo que o esperado...
        </p>
      )}

      {state.phase === "error" && (
        <p className="mt-3 text-sm text-red-700">{state.error}</p>
      )}

      <Timeline events={state.events} live={live} />

      {result && (
        <div className="mt-4 space-y-2.5 text-sm">
          {result.secretario && (
            <Field icon={<User className="h-4 w-4" />} label="Secretário(a)" value={result.secretario} />
          )}
          {result.cargo && (
            <Field icon={<Briefcase className="h-4 w-4" />} label="Cargo" value={result.cargo} />
          )}
          {result.emails.length > 0 && (
            <Field
              icon={<Mail className="h-4 w-4" />}
              label="E-mail"
              value={result.emails.join(", ")}
            />
          )}
          {result.telefones.length > 0 && (
            <Field
              icon={<Phone className="h-4 w-4" />}
              label="Telefone"
              value={result.telefones.join(", ")}
            />
          )}
          {result.fonte && (
            <Field
              icon={<ExternalLink className="h-4 w-4" />}
              label="Fonte"
              value={
                result.fonteUrl ? (
                  <a
                    href={result.fonteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-700 hover:underline"
                  >
                    {result.fonte}
                  </a>
                ) : (
                  result.fonte
                )
              }
            />
          )}
          {result.contexto && (
            <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-muted-foreground">
              {result.contexto}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="flex-1">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm text-foreground">{value}</div>
      </div>
    </div>
  );
}

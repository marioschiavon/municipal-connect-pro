// Cliente do Querido Diário (Open Knowledge Brasil).
// API pública, sem chave. Indexa diários oficiais municipais com OCR.
// Docs: https://api.queridodiario.ok.org.br/docs

const BASE = "https://api.queridodiario.ok.org.br/gazettes";

export type DiarioExcerpt = {
  data: string; // ISO yyyy-mm-dd
  url: string;
  trecho: string;
  /** ≤ 120 dias da data atual. */
  isRecent: boolean;
  /** Dias desde a publicação (Infinity quando data ausente). */
  ageDays: number;
};

export type DiarioBusca =
  | { ok: true; total: number; excerpts: DiarioExcerpt[] }
  | { ok: false; reason: string };

type RawGazette = {
  territory_id?: string;
  date?: string;
  url?: string;
  txt_url?: string;
  excerpts?: string[];
};

type RawResponse = {
  total_gazettes?: number;
  gazettes?: RawGazette[];
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function ageInDays(iso: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export async function buscarDiario(
  ibgeId: number,
  querystring: string,
  opts: { size?: number; sinceDays?: number; timeoutMs?: number } = {},
): Promise<DiarioBusca> {
  const size = opts.size ?? 5;
  const sinceDays = opts.sinceDays ?? 180; // últimos 6 meses por padrão
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const params = new URLSearchParams({
    territory_ids: String(ibgeId),
    querystring,
    size: String(size),
    sort_by: "descending_date", // mais novo primeiro
    pre_tags: "",
    post_tags: "",
    published_since: isoDaysAgo(sinceDays),
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
    "User-Agent": "MunicipIA/0.10 (+prospeccao-educacao; contato via app)",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}?${params.toString()}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = (await res.json()) as RawResponse;
    const gazettes = json.gazettes ?? [];
    const excerpts: DiarioExcerpt[] = [];
    for (const g of gazettes) {
      const url = g.url ?? g.txt_url ?? "";
      const date = g.date ?? "";
      const age = ageInDays(date);
      for (const ex of g.excerpts ?? []) {
        const trecho = ex.replace(/\s+/g, " ").trim();
        if (trecho.length < 20) continue;
        excerpts.push({
          data: date,
          url,
          trecho: trecho.slice(0, 600),
          isRecent: age <= 120,
          ageDays: age,
        });
        if (excerpts.length >= size * 2) break;
      }
      if (excerpts.length >= size * 2) break;
    }
    // Garante ordem cronológica decrescente (mais novo primeiro)
    excerpts.sort((a, b) => a.ageDays - b.ageDays);
    return { ok: true, total: json.total_gazettes ?? gazettes.length, excerpts };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, reason: aborted ? `timeout ${timeoutMs}ms` : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function formatExcerptsForPrompt(excerpts: DiarioExcerpt[]): string {
  if (excerpts.length === 0) return "";
  // Já vem ordenado do mais novo pro mais antigo
  const linhas = excerpts.map((e, i) => {
    const data = e.data ? `📅 ${e.data}${e.isRecent ? " (recente)" : ` (~${Math.floor(e.ageDays / 30)} meses atrás)`}` : "📅 sem data";
    return `  ${i + 1}. ${data}\n     ${e.trecho}`;
  });
  return `\n### Pistas do Diário Oficial (Querido Diário) — ordenadas do MAIS NOVO para o mais antigo
IMPORTANTE: use prioritariamente o trecho mais RECENTE como fonte do nome.
Se trechos antigos contradizerem um mais novo, descarte os antigos (pode ter havido troca de secretário).
${linhas.join("\n")}
`;
}

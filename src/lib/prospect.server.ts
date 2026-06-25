import Firecrawl from "@mendable/firecrawl-js";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { fetchHtml, htmlToMarkdown, extractContactsRegex } from "./scraper.server";
import type {
  Hierarquia,
  ProgressEvent,
  ProgressLevel,
  ProspectResult,
} from "./prospect.types";

export type { Hierarquia, ProspectResult };

const ExtractSchema = z.object({
  secretario: z
    .string()
    .nullable()
    .describe("Nome completo do(a) secretário(a) de Educação, se aparecer literalmente; senão null"),
  cargo: z.string().nullable().describe("Cargo/título exato encontrado; null se não encontrado"),
  emails: z.array(z.string()).describe("E-mails de contato encontrados (literalmente no texto)"),
  telefones: z
    .array(z.string())
    .describe("Telefones de contato encontrados (literalmente, formato brasileiro)"),
  contexto: z
    .string()
    .nullable()
    .describe("1 frase explicando o que foi achado (ex.: 'E-mail institucional da SEMED')"),
  confianca: z.enum(["alta", "media", "baixa"]).describe("Quão confiante você está nos dados"),
});

type Extracted = z.infer<typeof ExtractSchema>;

type EtapaTag = Hierarquia | "init" | "fallback" | "final";

type Emit = (
  level: ProgressLevel,
  etapa: EtapaTag,
  message: string,
  data?: unknown,
) => void;


function getFirecrawl() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY ausente");
  return new Firecrawl({ apiKey: key });
}

function getProvider() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY ausente");
  return createLovableAiGatewayProvider(key);
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function searchFirstUrl(
  fc: Firecrawl,
  query: string,
  prefer: (url: string) => boolean,
  emit: Emit,
  etapa: Hierarquia,
): Promise<string | null> {
  emit("info", etapa, `Pesquisando no Google via Firecrawl: "${query}"`);
  try {
    const res = await fc.search(query, { limit: 6 });
    const web = (res as { web?: Array<{ url: string; title?: string }> }).web ?? [];
    emit("info", etapa, `Recebi ${web.length} resultado(s) do buscador`, {
      candidatos: web.map((r) => r.url),
    });
    if (web.length === 0) {
      emit("warn", etapa, "Nenhum resultado retornado pelo buscador");
      return null;
    }
    const preferred = web.find((r) => prefer(r.url));
    const chosen = (preferred ?? web[0]).url ?? null;
    if (chosen) {
      emit(
        "success",
        etapa,
        preferred
          ? `Escolhi um site .gov.br: ${shortHost(chosen)}`
          : `Sem .gov.br preferencial, vou tentar: ${shortHost(chosen)}`,
        { url: chosen },
      );
    }
    return chosen;
  } catch (e) {
    emit("error", etapa, "Erro na busca do Firecrawl", String(e));
    return null;
  }
}

async function scrapeMarkdown(
  fc: Firecrawl,
  url: string,
  emit: Emit,
  etapa: Hierarquia,
): Promise<string | null> {
  // 1) Tentativa nativa: fetch + parser próprio (rápido, sem custo).
  emit("info", etapa, `Baixando ${shortHost(url)} direto (fetch nativo)...`);
  const native = await fetchHtml(url, {
    emit: (msg, data) => emit("info", etapa, msg, data),
  });
  if (native.ok) {
    const md = htmlToMarkdown(native.html);
    const useful = md.replace(/\s+/g, " ").trim();
    if (useful.length >= 200) {
      const kb = (native.bytes / 1024).toFixed(1);
      emit(
        "success",
        etapa,
        `Página baixada direto (${kb} KB → ${md.length.toLocaleString("pt-BR")} chars markdown)`,
        { via: "native", bytes: native.bytes, finalUrl: native.finalUrl },
      );
      return md;
    }
    emit("warn", etapa, "HTML nativo veio vazio/curto — usando Firecrawl como fallback", {
      length: useful.length,
    });
  } else {
    emit("warn", etapa, `Fetch nativo falhou (${native.reason}) — caindo pro Firecrawl`);
  }

  // 2) Fallback: Firecrawl.
  emit("info", etapa, `Lendo a página ${shortHost(url)} via Firecrawl...`);
  try {
    const res = await fc.scrape(url, {
      formats: ["markdown"],
      onlyMainContent: true,
    });
    const md =
      (res as { markdown?: string }).markdown ??
      (res as { data?: { markdown?: string } }).data?.markdown ??
      null;
    if (!md || md.length < 50) {
      emit("warn", etapa, "Página vazia ou muito curta (Firecrawl)", { length: md?.length ?? 0 });
      return md && md.length > 50 ? md : null;
    }
    emit(
      "success",
      etapa,
      `Página lida via Firecrawl (${md.length.toLocaleString("pt-BR")} caracteres)`,
      { via: "firecrawl" },
    );
    return md.slice(0, 18000);
  } catch (e) {
    emit("error", etapa, "Erro no scrape do Firecrawl", String(e));
    return null;
  }
}

async function extractWithAI(
  markdown: string,
  url: string,
  etapa: Hierarquia,
  municipio: string,
  uf: string,
  emit: Emit,
): Promise<Extracted | null> {
  const provider = getProvider();

  const focoEtapa =
    etapa === "educacao"
      ? "Secretaria Municipal de Educação — nome do(a) Secretário(a) de Educação e e-mails/telefones DELA ou DA secretaria."
      : etapa === "geral"
        ? "Contato institucional GERAL da prefeitura (ouvidoria, fale-conosco, secretaria geral, telefone/e-mail principal)."
        : "Contato do Gabinete do Prefeito ou do próprio Prefeito (último recurso).";

  const hints = extractContactsRegex(markdown);
  const hintsBlock =
    hints.emails.length || hints.telefones.length
      ? `\nPISTAS pré-extraídas por regex (use SOMENTE se também aparecerem no conteúdo abaixo, e descarte falsos positivos):\n  e-mails: ${hints.emails.join(", ") || "—"}\n  telefones: ${hints.telefones.join(", ") || "—"}\n`
      : "";

  const prompt = `Você é um analista que extrai contatos institucionais de páginas oficiais da prefeitura de ${municipio}/${uf}.

ALVO PRINCIPAL DO PROJETO:
  Secretaria Municipal de Educação de ${municipio}/${uf}.
  O que mais queremos: NOME do(a) Secretário(a) de Educação + E-MAILS e TELEFONES dela ou da Secretaria de Educação.

ORDEM DE FALLBACK (use só se o alvo principal não estiver na página):
  1. Educação (alvo principal).
  2. Contato GERAL da prefeitura (ouvidoria, fale-conosco, secretaria geral, e-mail/telefone institucional).
  3. Gabinete do prefeito ou contato direto do prefeito.

FOCO DESTA EXTRAÇÃO (etapa = "${etapa}"):
  ${focoEtapa}

REGRAS RÍGIDAS:
- NUNCA invente. Só extraia o que aparece LITERALMENTE no texto fornecido.
- "secretario" só com o nome de uma pessoa real, citada como responsável pela Educação.
- E-mails e telefones precisam aparecer literalmente. Telefones em formato brasileiro (com DDD se houver).
- "confianca" = "alta" só se o alvo desta etapa estiver claramente identificado nesta página.
- Se a página claramente não traz nada útil para esta etapa, devolva arrays vazios e confianca = "baixa".

URL analisada: ${url}
${hintsBlock}
Conteúdo (markdown):
"""
${markdown}
"""`;
  emit("info", etapa, "Pedindo para a IA extrair os contatos desta página...", {
    pistas: hints,
  });
  try {
    const { experimental_output } = await generateText({
      model: provider("google/gemini-3-flash-preview"),
      experimental_output: Output.object({ schema: ExtractSchema }),
      prompt,
    });
    const out = experimental_output as Extracted;
    emit(
      out.confianca === "baixa" ? "warn" : "success",
      etapa,
      `IA respondeu — secretário: ${out.secretario ?? "—"} · ${out.emails.length} e-mail(s) · ${out.telefones.length} tel · confiança ${out.confianca}`,
      out,
    );
    return out;
  } catch (e) {
    emit("error", etapa, "Erro na chamada da IA", String(e));
    return null;
  }
}

function hasUsefulContact(e: Extracted | null): boolean {
  if (!e) return false;
  return (e.emails.length > 0 || e.telefones.length > 0) && e.confianca !== "baixa";
}

function fonteLabel(etapa: Hierarquia) {
  return etapa === "educacao"
    ? "Secretaria de Educação"
    : etapa === "geral"
      ? "Contato geral da prefeitura"
      : "Gabinete do Prefeito (último recurso)";
}

async function runEtapa(
  fc: Firecrawl,
  query: string,
  prefer: (u: string) => boolean,
  etapa: Hierarquia,
  municipio: string,
  uf: string,
  emit: Emit,
): Promise<{ extracted: Extracted; url: string } | null> {
  const url = await searchFirstUrl(fc, query, prefer, emit, etapa);
  if (!url) return null;
  const md = await scrapeMarkdown(fc, url, emit, etapa);
  if (!md) return null;
  const extracted = await extractWithAI(md, url, etapa, municipio, uf, emit);
  if (!extracted) return null;
  return { extracted, url };
}

export async function prospectar(
  municipio: string,
  uf: string,
  onEvent?: (evt: ProgressEvent) => void,
): Promise<ProspectResult> {
  const emit: Emit = (level, etapa, message, data) => {
    onEvent?.({
      kind: "progress",
      level,
      etapa,
      message,
      data,
      ts: Date.now(),
    });
  };

  emit("info", "init", `Iniciando prospecção de ${municipio}/${uf}`);
  emit(
    "info",
    "init",
    "Alvo: Secretaria de Educação (nome + contatos). Fallback: contato geral da prefeitura → gabinete do prefeito.",
  );

  const fc = getFirecrawl();

  // Etapa 1: Educação
  emit("info", "educacao", "Etapa 1 de 3 — procurando a Secretaria de Educação");
  const e1 = await runEtapa(
    fc,
    `prefeitura municipal ${municipio} ${uf} secretaria de educação contato secretário`,
    (u) => /\.gov\.br/i.test(u) && /(educa|secretari)/i.test(u),
    "educacao",
    municipio,
    uf,
    emit,
  );
  if (e1 && hasUsefulContact(e1.extracted)) {
    emit("success", "educacao", "Contato direto da Educação encontrado — parando aqui");
    const result: ProspectResult = {
      status: "found",
      hierarquia: "educacao",
      secretario: e1.extracted.secretario,
      cargo: e1.extracted.cargo,
      emails: e1.extracted.emails,
      telefones: e1.extracted.telefones,
      fonte: fonteLabel("educacao"),
      fonteUrl: e1.url,
      contexto: e1.extracted.contexto,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }
  emit(
    "warn",
    "fallback",
    "Não consegui contato útil da Educação — caindo para o fallback (contato geral da prefeitura)",
  );

  // Etapa 2: Geral
  emit("info", "geral", "Etapa 2 de 3 — procurando um contato geral da prefeitura");
  const e2 = await runEtapa(
    fc,
    `secretaria geral prefeitura ${municipio} ${uf} contato e-mail telefone ouvidoria`,
    (u) => /\.gov\.br/i.test(u),
    "geral",
    municipio,
    uf,
    emit,
  );
  if (e2 && hasUsefulContact(e2.extracted)) {
    emit("success", "geral", "Achei um contato geral utilizável");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "geral",
      secretario: e2.extracted.secretario,
      cargo: e2.extracted.cargo,
      emails: e2.extracted.emails,
      telefones: e2.extracted.telefones,
      fonte: fonteLabel("geral"),
      fonteUrl: e2.url,
      contexto: e2.extracted.contexto ?? "Contato geral da prefeitura (sem dados da Educação)",
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }
  emit("warn", "fallback", "Sem contato geral utilizável — última tentativa: gabinete do prefeito");

  // Etapa 3: Gabinete
  emit("info", "gabinete", "Etapa 3 de 3 — procurando o gabinete do prefeito");
  const e3 = await runEtapa(
    fc,
    `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`,
    (u) => /\.gov\.br/i.test(u),
    "gabinete",
    municipio,
    uf,
    emit,
  );
  if (e3 && hasUsefulContact(e3.extracted)) {
    emit("success", "gabinete", "Achei contato no gabinete do prefeito");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "gabinete",
      secretario: e3.extracted.secretario,
      cargo: e3.extracted.cargo,
      emails: e3.extracted.emails,
      telefones: e3.extracted.telefones,
      fonte: fonteLabel("gabinete"),
      fonteUrl: e3.url,
      contexto: e3.extracted.contexto ?? "Contato do gabinete do prefeito",
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  // Fallback: melhor parcial
  const best = [e1, e2, e3].find(
    (x) => x && (x.extracted.emails.length || x.extracted.telefones.length),
  );
  if (best) {
    const h: Hierarquia = best === e1 ? "educacao" : best === e2 ? "geral" : "gabinete";
    emit("warn", "fallback", `Devolvendo o melhor parcial encontrado (${fonteLabel(h)})`);
    const result: ProspectResult = {
      status: "partial",
      hierarquia: h,
      secretario: best.extracted.secretario,
      cargo: best.extracted.cargo,
      emails: best.extracted.emails,
      telefones: best.extracted.telefones,
      fonte: fonteLabel(h),
      fonteUrl: best.url,
      contexto: best.extracted.contexto,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  emit("error", "final", "Não encontrei nada utilizável em nenhuma das três etapas");
  const result: ProspectResult = {
    status: "not_found",
    hierarquia: null,
    secretario: null,
    cargo: null,
    emails: [],
    telefones: [],
    fonte: null,
    fonteUrl: null,
    contexto: "Nenhum contato encontrado nas etapas Educação, Geral e Gabinete.",
  };
  onEvent?.({ kind: "final", result, ts: Date.now() });
  return result;
}

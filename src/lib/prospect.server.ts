import Firecrawl from "@mendable/firecrawl-js";
import { generateObject } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { fetchHtml, htmlToMarkdown, extractContactsRegex } from "./scraper.server";
import { buscarDiario, formatExcerptsForPrompt, type DiarioExcerpt } from "./querido-diario.server";
import type {
  EtapaTag,
  Hierarquia,
  ProgressEvent,
  ProgressLevel,
  ProspectResult,
} from "./prospect.types";

export type { Hierarquia, ProspectResult };

const ConfiancaEnum = z.enum(["alta", "media", "baixa"]);
const ConfiancaLoose = z
  .union([ConfiancaEnum, z.string()])
  .transform((v) => {
    const s = String(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    if (["alta", "high", "alto"].includes(s)) return "alta" as const;
    if (["baixa", "low", "baixo"].includes(s)) return "baixa" as const;
    return "media" as const;
  });

const ExtractSchema = z.object({
  secretario: z.string().nullable().optional().default(null),
  cargo: z.string().nullable().optional().default(null),
  emails: z.array(z.string()).optional().default([]),
  telefones: z.array(z.string()).optional().default([]),
  contexto: z.string().nullable().optional().default(null),
  confianca: ConfiancaLoose.default("baixa"),
  dataReferencia: z.string().nullable().optional().default(null),
});

const NomeSchema = z.object({
  secretario: z.string().nullable().optional().default(null),
  cargo: z.string().nullable().optional().default(null),
  contexto: z.string().nullable().optional().default(null),
  confianca: ConfiancaLoose.default("baixa"),
  dataReferencia: z.string().nullable().optional().default(null),
});

type Extracted = {
  secretario: string | null;
  cargo: string | null;
  emails: string[];
  telefones: string[];
  contexto: string | null;
  confianca: "alta" | "media" | "baixa";
  dataReferencia: string | null;
};

type NomeOnly = {
  secretario: string | null;
  cargo: string | null;
  contexto: string | null;
  confianca: "alta" | "media" | "baixa";
  dataReferencia: string | null;
};

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

type SearchCandidate = {
  url: string;
  title: string;
  description: string;
  markdown: string | null;
};

function isBlockedHost(url: string): boolean {
  return /(?:instagram\.com|facebook\.com|youtube\.com|tiktok\.com|twitter\.com|x\.com)/i.test(url);
}

async function searchCandidates(
  fc: Firecrawl,
  query: string,
  emit: Emit,
  etapa: EtapaTag,
  withScrape = true,
  tbs?: string,
): Promise<SearchCandidate[]> {
  const tbsLabel = tbs ? ` [filtro: ${tbs}]` : "";
  emit("info", etapa, `Pesquisando no Google via Firecrawl${tbsLabel}: "${query}"`);
  try {
    const baseOpts: { limit: number; tbs?: string; scrapeOptions?: { formats: ("markdown" | "html")[]; onlyMainContent?: boolean } } = { limit: 5 };
    if (tbs) baseOpts.tbs = tbs;
    if (withScrape) baseOpts.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
    const res = await fc.search(query, baseOpts as Parameters<Firecrawl["search"]>[1]);
    const web =
      (res as { web?: Array<{ url: string; title?: string; description?: string; markdown?: string }> })
        .web ?? [];
    const cands: SearchCandidate[] = web
      .filter((r) => r.url && !isBlockedHost(r.url))
      .map((r) => ({
        url: r.url,
        title: r.title ?? "",
        description: r.description ?? "",
        markdown: r.markdown && r.markdown.length > 80 ? r.markdown.slice(0, 6000) : null,
      }));
    emit("info", etapa, `Recebi ${cands.length} candidato(s) úteis do buscador`, {
      candidatos: cands.map((c) => ({
        url: c.url,
        snippet: `${c.title} — ${c.description}`.slice(0, 200),
        temMarkdown: !!c.markdown,
      })),
    });
    if (cands.length === 0) {
      emit("warn", etapa, "Nenhum resultado utilizável retornado pelo buscador");
    }
    return cands;
  } catch (e) {
    emit("error", etapa, "Erro na busca do Firecrawl", String(e));
    return [];
  }
}

function dedupeCandidates(lists: SearchCandidate[][]): SearchCandidate[] {
  const seen = new Set<string>();
  const out: SearchCandidate[] = [];
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

function snippetsBlock(cands: SearchCandidate[]): string {
  if (cands.length === 0) return "";
  const lines = cands.map(
    (c, i) =>
      `[${i + 1}] ${c.title}\n    URL: ${c.url}\n    Resumo: ${c.description || "(sem resumo)"}`,
  );
  return `### Resultados do Google (snippets — frequentemente já trazem nome/contato)\n${lines.join("\n")}\n`;
}

function preferGov(cands: SearchCandidate[], extra?: (u: string) => boolean): SearchCandidate[] {
  const score = (c: SearchCandidate) => {
    let s = 0;
    if (/\.gov\.br/i.test(c.url)) s += 10;
    if (extra && extra(c.url)) s += 5;
    if (c.markdown) s += 2;
    return -s; // sort ascending = best first when negated
  };
  return [...cands].sort((a, b) => score(a) - score(b));
}

async function scrapeMarkdown(
  fc: Firecrawl,
  url: string,
  emit: Emit,
  etapa: EtapaTag,
): Promise<string | null> {
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

async function extractNomeWithAI(
  markdown: string,
  url: string,
  municipio: string,
  uf: string,
  diarioBlock: string,
  emit: Emit,
): Promise<NomeOnly | null> {
  const provider = getProvider();
  const anoAtual = new Date().getFullYear();
  const prompt = `Você é um analista que identifica autoridades municipais a partir de páginas oficiais de ${municipio}/${uf}.
Hoje é ${new Date().toISOString().slice(0, 10)} (ano corrente: ${anoAtual}).

OBJETIVO ÚNICO desta etapa:
  Descobrir o NOME COMPLETO do(a) Secretário(a) Municipal de Educação ATUAL de ${municipio}/${uf}.
  NÃO precisa extrair contatos agora. Foco só no nome ATUAL (em exercício hoje).

REGRAS:
- Só devolva um nome se ele aparecer LITERALMENTE no conteúdo abaixo, citado como responsável pela Secretaria de Educação (pode ser "Secretário(a) de Educação", "titular da Secretaria Municipal de Educação", etc.).
- "confianca" = "alta" só se o nome estiver explicitamente associado ao cargo de Secretário(a) de Educação E houver indício de que é a gestão atual.
- Se não houver nome, devolva secretario = null.

REGRAS DE ATUALIDADE (CRÍTICO — a busca pode retornar dados desatualizados):
- Se aparecer MAIS DE UM nome como Secretário(a) de Educação, escolha o mais RECENTEMENTE empossado. Pistas: "nomeado", "empossado", "tomou posse", "decreto nº ...", "a partir de DD/MM/AAAA", data mais recente.
- Snippets do Google geralmente refletem o(a) titular ATUAL — PREFIRA-OS ao Diário Oficial quando houver conflito, A MENOS QUE o trecho do diário seja claramente mais recente (data posterior).
- Se houver indicação de exoneração/saída/troca, IGNORE o nome anterior e use o sucessor citado.
- Preencha "dataReferencia" com a data/mês/ano da evidência usada (ex.: "2025-11", "abril/2025", "${anoAtual}"). Se não houver data, deixe null.

URL: ${url}
${diarioBlock}
Conteúdo (markdown):
"""
${markdown}
"""

Responda APENAS com JSON válido seguindo o schema.`;
  emit("info", "nome", "Pedindo à IA o nome do(a) Secretário(a) de Educação...");
  try {
    const { object } = await generateObject({
      model: provider("google/gemini-3-flash-preview"),
      schema: NomeSchema,
      prompt,
    });
    const out = object as NomeOnly;
    emit(
      out.secretario ? "success" : "warn",
      "nome",
      out.secretario
        ? `IA identificou: ${out.secretario} (${out.cargo ?? "cargo n/d"}) · confiança ${out.confianca}`
        : "IA não conseguiu confirmar um nome nessa página",
      out,
    );
    return out;
  } catch (e) {
    const err = e as { message?: string };
    emit("error", "nome", "IA falhou ao buscar o nome", { message: err?.message });
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
  nomeAlvo?: string | null,
  extraMarkdown?: string,
): Promise<Extracted | null> {
  const provider = getProvider();

  const focoEtapa = nomeAlvo
    ? `Extrair E-MAIL e/ou TELEFONE vinculados a "${nomeAlvo}" (ou à Secretaria de Educação que ele(a) chefia).`
    : etapa === "educacao"
      ? "Secretaria Municipal de Educação — nome do(a) Secretário(a) e e-mails/telefones DELA ou DA secretaria."
      : etapa === "geral"
        ? "Contato institucional GERAL da prefeitura (ouvidoria, fale-conosco, secretaria geral, telefone/e-mail principal)."
        : "Contato do Gabinete do Prefeito ou do próprio Prefeito (último recurso).";

  const hintsMd = extractContactsRegex(markdown);
  const hintsExtra = extraMarkdown ? extractContactsRegex(extraMarkdown) : { emails: [], telefones: [] };
  const hints = {
    emails: Array.from(new Set([...hintsExtra.emails, ...hintsMd.emails])),
    telefones: Array.from(new Set([...hintsExtra.telefones, ...hintsMd.telefones])),
  };
  if (extraMarkdown && (hintsExtra.emails.length || hintsExtra.telefones.length)) {
    emit("info", etapa, `Snippets do Google já trouxeram ${hintsExtra.emails.length} e-mail(s) e ${hintsExtra.telefones.length} tel por regex`, hintsExtra);
  }
  const hintsBlock =
    hints.emails.length || hints.telefones.length
      ? `\nPISTAS pré-extraídas por regex (use SOMENTE se também aparecerem no conteúdo abaixo, e descarte falsos positivos):\n  e-mails: ${hints.emails.join(", ") || "—"}\n  telefones: ${hints.telefones.join(", ") || "—"}\n`
      : "";

  const fullMd = extraMarkdown ? `${extraMarkdown}\n\n### Conteúdo do site\n${markdown}` : markdown;

  const anoAtual = new Date().getFullYear();
  const prompt = `Você é um analista que extrai contatos institucionais de páginas oficiais da prefeitura de ${municipio}/${uf}.
Hoje é ${new Date().toISOString().slice(0, 10)} (ano corrente: ${anoAtual}).

ALVO PRINCIPAL DO PROJETO:
  Secretaria Municipal de Educação de ${municipio}/${uf}.
  Queremos: NOME do(a) Secretário(a) ATUAL + E-MAILS e TELEFONES dela ou da Secretaria de Educação.

${nomeAlvo ? `NOME-ALVO CONFIRMADO: "${nomeAlvo}". Priorize contatos vinculados a essa pessoa.\n` : ""}
FOCO DESTA EXTRAÇÃO (etapa = "${etapa}"):
  ${focoEtapa}

REGRAS RÍGIDAS:
- NUNCA invente. Só extraia o que aparece LITERALMENTE no texto.
- "secretario" só com nome de pessoa real citada como responsável pela Educação.
- E-mails/telefones precisam aparecer literalmente no texto. Telefones brasileiros com DDD quando possível.
- "confianca" = "alta" só se o alvo desta etapa estiver claramente identificado.
- Se a página claramente não traz nada útil, devolva arrays vazios e confianca = "baixa".

REGRAS DE ATUALIDADE (CRÍTICO):
- Se aparecer MAIS DE UM nome como Secretário(a) de Educação, escolha o ATUAL — o mais recentemente empossado. Pistas: "nomeado", "empossado", "tomou posse", "decreto nº ...", data mais recente.
- Snippets do Google (quando presentes) geralmente refletem o titular ATUAL — prefira-os ao Diário Oficial em caso de conflito, A MENOS QUE o trecho do diário seja claramente mais recente.
- Se houver indicação de exoneração/troca, ignore o nome antigo e use o sucessor.
- Preencha "dataReferencia" com a data/mês/ano da evidência usada (ex.: "2025-11", "abril/2025", "${anoAtual}"). Se não houver data, deixe null.
- Em "contexto" mencione brevemente a data citada quando relevante (ex.: "Empossada em 03/2025 por decreto nº...").

URL analisada: ${url}
${hintsBlock}
Conteúdo (markdown):
"""
${fullMd}
"""

Responda APENAS com JSON válido seguindo o schema.`;
  emit("info", etapa, "Pedindo para a IA extrair os contatos desta página...", { pistas: hints });
  try {
    const { object } = await generateObject({
      model: provider("google/gemini-3-flash-preview"),
      schema: ExtractSchema,
      prompt,
    });
    const out = object as Extracted;
    if (nomeAlvo && !out.secretario) out.secretario = nomeAlvo;
    emit(
      out.confianca === "baixa" ? "warn" : "success",
      etapa,
      `IA respondeu — secretário: ${out.secretario ?? "—"} · ${out.emails.length} e-mail(s) · ${out.telefones.length} tel · confiança ${out.confianca}`,
      out,
    );
    return out;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string }; text?: string };
    emit("error", etapa, "Erro na IA: schema não bateu — usando regex como fallback", {
      message: err?.message,
      cause: err?.cause?.message,
      rawText: err?.text?.slice(0, 500),
    });
    if (hints.emails.length || hints.telefones.length) {
      const fallback: Extracted = {
        secretario: nomeAlvo ?? null,
        cargo: null,
        emails: hints.emails.slice(0, 5),
        telefones: hints.telefones.slice(0, 5),
        contexto: "IA falhou — contatos extraídos por regex da página",
        confianca: "baixa",
        dataReferencia: null,
      };
      emit("warn", etapa, `Regex recuperou ${fallback.emails.length} e-mail(s) e ${fallback.telefones.length} tel`, fallback);
      return fallback;
    }
    return null;
  }
}

function hasUsefulContact(e: Extracted | null): boolean {
  if (!e) return false;
  return e.emails.length > 0 || e.telefones.length > 0;
}

function fonteLabel(etapa: Hierarquia) {
  return etapa === "educacao"
    ? "Secretaria de Educação"
    : etapa === "geral"
      ? "Contato geral da prefeitura"
      : "Gabinete do Prefeito (último recurso)";
}

/** Tenta extrair um nome a partir dos trechos do diário oficial sem chamar IA.
 *  Excerpts já vêm ordenados do mais novo para o mais antigo. */
function nomeDoDiario(
  excerpts: DiarioExcerpt[],
): { nome: string; data: string; ageDays: number; conflito?: string } | null {
  if (excerpts.length === 0) return null;
  const re =
    /secret[áa]ri[oa](?:\s+municipal)?\s+(?:de\s+)?educa[çc][ãa]o[^.,;:\n]{0,30}?[,:\-–]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+){0,3})/i;
  let escolhido: { nome: string; data: string; ageDays: number } | null = null;
  let anterior: string | null = null;
  for (const ex of excerpts) {
    const m = ex.trecho.match(re);
    if (!m) continue;
    const nome = m[1].trim();
    if (!escolhido) {
      escolhido = { nome, data: ex.data, ageDays: ex.ageDays };
    } else if (nome.toLowerCase() !== escolhido.nome.toLowerCase() && !anterior) {
      anterior = nome;
    }
  }
  if (!escolhido) return null;
  return { ...escolhido, conflito: anterior ?? undefined };
}

export async function prospectar(
  municipio: string,
  uf: string,
  onEvent?: (evt: ProgressEvent) => void,
  ibgeId?: number,
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
    "Estratégia escalonada: (A) descobrir nome → (B) buscar contatos do nome → (C) contato institucional → (D) fallback geral.",
  );

  const fc = getFirecrawl();

  // ===== ESTÁGIO A: descobrir o NOME =====
  let nomeSecretario: string | null = null;
  let nomeFonte: "diario" | "site" | "busca-nome" | "snippet" | null = null;
  let dataReferenciaGlobal: string | null = null;
  let urlSiteEducacao: string | null = null;
  let mdSiteEducacao: string | null = null;
  let extraConfirmado: Extracted | null = null; // se já veio contato no site institucional

  // A1: Querido Diário em paralelo com a busca do site
  let diarioExcerpts: DiarioExcerpt[] = [];
  let diarioPromise: Promise<void> = Promise.resolve();
  if (ibgeId) {
    emit("info", "diario", `Consultando Querido Diário (cód. IBGE ${ibgeId}, últimos 6 meses)...`);
    diarioPromise = (async () => {
      const r = await buscarDiario(
        ibgeId,
        '"secretário de educação" OR "secretária de educação" OR "secretario municipal de educação"',
        { size: 5, sinceDays: 180 },
      );
      if (!r.ok) {
        emit("warn", "diario", `Diário Oficial indisponível (${r.reason}) — seguindo sem ele`);
        return;
      }
      if (r.excerpts.length === 0) {
        emit("info", "diario", "Sem menções recentes ao Secretário de Educação no diário municipal");
        return;
      }
      diarioExcerpts = r.excerpts;
      emit(
        "success",
        "diario",
        `Encontrei ${r.excerpts.length} trecho(s) no diário (mais novo: ${r.excerpts[0]?.data || "?"})`,
        { excerpts: r.excerpts.slice(0, 3) },
      );
      const cand = nomeDoDiario(r.excerpts);
      if (cand) {
        // Só adota como nomeFonte=diario se for ≤ 365 dias (1 ano).
        if (cand.ageDays <= 365) {
          nomeSecretario = cand.nome;
          nomeFonte = "diario";
          dataReferenciaGlobal = cand.data || null;
          emit(
            "success",
            "diario",
            `Pista forte do diário (${cand.data}, há ~${Math.floor(cand.ageDays / 30)} meses): nome provável = ${cand.nome}`,
          );
          if (cand.conflito) {
            emit(
              "warn",
              "nome",
              `Conflito no diário: trecho mais antigo cita "${cand.conflito}" — adotando "${cand.nome}" (mais recente)`,
            );
          }
        } else {
          emit(
            "warn",
            "diario",
            `Trecho do diário é antigo (${cand.data}, ~${Math.floor(cand.ageDays / 30)} meses) — vou tratar como pista fraca e exigir confirmação`,
          );
        }
      }
    })();
  } else {
    emit("info", "diario", "Sem código IBGE — pulando consulta ao Querido Diário");
  }

  // A2: busca + scrape (em batch) do site oficial da Educação — 3 queries focando atualidade
  emit("info", "nome", "Estágio A — descobrindo o nome ATUAL do(a) Secretário(a) de Educação");
  const anoAtual = new Date().getFullYear();
  const [candsA1, candsA2, candsA3] = await Promise.all([
    searchCandidates(
      fc,
      `"secretário de educação" ${municipio} ${uf} ${anoAtual}`,
      emit,
      "nome",
      true,
      "qdr:y",
    ),
    searchCandidates(
      fc,
      `secretaria municipal educação ${municipio} ${uf} "atual" OR "nomeado" OR "empossado"`,
      emit,
      "nome",
      true,
      "qdr:y",
    ),
    searchCandidates(
      fc,
      `prefeitura municipal ${municipio} ${uf} secretaria de educação secretário nome contato`,
      emit,
      "nome",
    ),
  ]);
  const candsA = dedupeCandidates([candsA1, candsA2, candsA3]);
  emit("info", "nome", `Após dedupe: ${candsA.length} candidato(s) únicos das 3 buscas`);
  const rankedA = preferGov(candsA, (u) => /(educa|secretari)/i.test(u));
  const topA = rankedA[0] ?? null;
  urlSiteEducacao = topA?.url ?? null;

  // Markdown agregado: usa o que o Firecrawl já trouxe via scrapeOptions.
  const inlineMdA = rankedA
    .filter((c) => c.markdown)
    .map((c) => `--- ${shortHost(c.url)} (${c.url}) ---\n${c.markdown}`)
    .join("\n\n");
  if (inlineMdA) {
    const kb = (inlineMdA.length / 1024).toFixed(1);
    emit(
      "success",
      "nome",
      `Firecrawl trouxe markdown de ${rankedA.filter((c) => c.markdown).length} página(s) já no search (~${kb} KB)`,
    );
  } else if (topA) {
    // Fallback: tenta scrapear top candidato sob demanda.
    mdSiteEducacao = await scrapeMarkdown(fc, topA.url, emit, "nome");
  }
  const snippetsA = snippetsBlock(rankedA);
  // Conteúdo "para a IA" = snippets do Google + markdown agregado (ou scrape sob demanda).
  const contentA = inlineMdA || mdSiteEducacao || "";
  const combinedA = [snippetsA, contentA].filter(Boolean).join("\n\n");
  if (contentA) mdSiteEducacao = contentA;
  const onlySnippets = !contentA && !!snippetsA;
  if (onlySnippets) {
    emit("info", "nome", "Sem markdown da página — vou extrair nome/contatos direto dos snippets do Google");
  }

  // Espera o diário no máximo 6s — se travar, segue sem ele.
  const diarioTimeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 6_000),
  );
  const raced = await Promise.race([diarioPromise.then(() => "done" as const), diarioTimeout]);
  if (raced === "timeout") {
    emit("warn", "diario", "Querido Diário demorou demais — seguindo sem ele");
  }
  const diarioBlock = formatExcerptsForPrompt(diarioExcerpts);

  // A3: tenta extração COMPLETA (snippets + markdown) — atalho feliz
  if (combinedA) {
    const urlForExtract = urlSiteEducacao ?? topA?.url ?? "(snippets do Google)";
    const full = await extractWithAI(
      combinedA,
      urlForExtract,
      "educacao",
      municipio,
      uf,
      emit,
      nomeSecretario,
      diarioBlock || undefined,
    );
    // Detecta conflito de nome entre diário e snippet/site — prefere o "atual" (IA).
    const prevNome = nomeSecretario as string | null;
    if (
      full?.secretario &&
      prevNome &&
      full.secretario.toLowerCase().trim() !== prevNome.toLowerCase().trim()
    ) {
      emit(
        "warn",
        "nome",
        `Conflito de nome: diário=${prevNome} / IA(site+snippet)=${full.secretario} — adotando "${full.secretario}" por ser provavelmente o atual`,
      );
      nomeSecretario = full.secretario;
      nomeFonte = onlySnippets ? "snippet" : "site";
      dataReferenciaGlobal = full.dataReferencia ?? dataReferenciaGlobal;
    } else if (full?.secretario && !prevNome) {
      nomeSecretario = full.secretario;
      nomeFonte = onlySnippets ? "snippet" : "site";
      dataReferenciaGlobal = full.dataReferencia ?? dataReferenciaGlobal;
    } else if (full?.dataReferencia && !dataReferenciaGlobal) {
      dataReferenciaGlobal = full.dataReferencia;
    }
    if (full && hasUsefulContact(full) && full.secretario) {
      const viaSnippet = onlySnippets;
      emit(
        "success",
        "educacao",
        viaSnippet
          ? "Atalho feliz: nome + contato extraídos direto dos snippets do Google"
          : "Atalho feliz: nome + contato direto (snippets + site oficial)",
      );
      const result: ProspectResult = {
        status: "found",
        hierarquia: "educacao",
        secretario: full.secretario,
        cargo: full.cargo,
        emails: full.emails,
        telefones: full.telefones,
        fonte: viaSnippet ? "Snippet do Google" : fonteLabel("educacao"),
        fonteUrl: urlSiteEducacao,
        contexto: full.contexto ?? (viaSnippet ? "Dados extraídos do resumo dos resultados do Google." : null),
        nomeFonte: viaSnippet ? "snippet" : nomeFonte,
        dataReferencia: full.dataReferencia ?? dataReferenciaGlobal,
      };
      onEvent?.({ kind: "final", result, ts: Date.now() });
      return result;
    }
    if (full && hasUsefulContact(full)) {
      extraConfirmado = full;
    }
  } else if (!nomeSecretario) {
    emit("warn", "nome", "Sem snippets nem markdown utilizáveis nesta busca");
  }

  // Se ainda não temos nome E temos conteúdo, faz extração focada em nome
  if (!nomeSecretario && combinedA) {
    const urlForName = urlSiteEducacao ?? topA?.url ?? "(snippets do Google)";
    const n = await extractNomeWithAI(
      combinedA,
      urlForName,
      municipio,
      uf,
      diarioBlock,
      emit,
    );
    if (n?.secretario) {
      nomeSecretario = n.secretario;
      nomeFonte = onlySnippets ? "snippet" : "site";
      dataReferenciaGlobal = n.dataReferencia ?? dataReferenciaGlobal;
    }
  }

  // ===== ESTÁGIO B: contatos a partir do NOME =====
  if (nomeSecretario) {
    emit(
      "info",
      "contato-secretario",
      `Estágio B — buscando contatos de "${nomeSecretario}" (${(nomeFonte as string | null) === "diario" ? "via Diário Oficial" : (nomeFonte as string | null) === "snippet" ? "via snippet do Google" : "via site oficial"})`,
    );
    const queries = [
      `"${nomeSecretario}" secretário educação ${municipio} ${uf} e-mail telefone`,
      `"${nomeSecretario}" secretaria municipal educação ${municipio} contato`,
    ];
    for (const q of queries) {
      const cands = await searchCandidates(fc, q, emit, "contato-secretario", true, "qdr:y");
      const ranked = preferGov(cands);
      if (ranked.length === 0) continue;
      const inlineMd = ranked
        .filter((c) => c.markdown)
        .map((c) => `--- ${shortHost(c.url)} ---\n${c.markdown}`)
        .join("\n\n");
      const snippets = snippetsBlock(ranked);
      const combined = [snippets, inlineMd].filter(Boolean).join("\n\n");
      if (!combined) continue;
      const u = ranked[0].url;
      const ext = await extractWithAI(
        combined,
        u,
        "educacao",
        municipio,
        uf,
        emit,
        nomeSecretario,
      );
      if (ext && hasUsefulContact(ext)) {
        const viaSnippetB = !inlineMd;
        emit(
          "success",
          "contato-secretario",
          viaSnippetB
            ? "Achei contato vinculado ao nome direto no snippet do Google — finalizando"
            : "Achei contato vinculado ao nome — finalizando",
        );
        const result: ProspectResult = {
          status: "found",
          hierarquia: "educacao",
          secretario: ext.secretario ?? nomeSecretario,
          cargo: ext.cargo,
          emails: ext.emails,
          telefones: ext.telefones,
          fonte: viaSnippetB ? "Snippet do Google" : fonteLabel("educacao"),
          fonteUrl: u,
          contexto:
            ext.contexto ??
            (viaSnippetB
              ? `Contato extraído do resumo do Google em busca dirigida ("${nomeSecretario}").`
              : `Contato encontrado em busca dirigida pelo nome ("${nomeSecretario}").`),
          nomeFonte: viaSnippetB && !nomeFonte ? "snippet" : nomeFonte,
          dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
        };
        onEvent?.({ kind: "final", result, ts: Date.now() });
        return result;
      }
    }
    emit("warn", "contato-secretario", "Buscas pelo nome não trouxeram contato útil — seguindo");
  } else {
    emit("warn", "nome", "Não consegui descobrir o nome — pulando para o fallback institucional");
  }

  // ===== ESTÁGIO C/D: fallback institucional =====
  if (extraConfirmado) {
    emit(
      "success",
      "educacao",
      "Sem contato vinculado ao nome, mas há contato institucional da Secretaria de Educação — registrando como parcial",
    );
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "educacao",
      secretario: nomeSecretario ?? extraConfirmado.secretario,
      cargo: extraConfirmado.cargo,
      emails: extraConfirmado.emails,
      telefones: extraConfirmado.telefones,
      fonte: fonteLabel("educacao"),
      fonteUrl: urlSiteEducacao,
      contexto: extraConfirmado.contexto ?? "Contato institucional da Secretaria (sem vínculo direto com a pessoa).",
      nomeFonte,
      dataReferencia: extraConfirmado.dataReferencia ?? dataReferenciaGlobal,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  // Helper local: roda um estágio de fallback (geral/gabinete) com batch search.
  async function runFallback(
    etapa: Hierarquia,
    query: string,
  ): Promise<{ ext: Extracted; url: string } | null> {
    const cands = await searchCandidates(fc, query, emit, etapa);
    const ranked = preferGov(cands);
    if (ranked.length === 0) return null;
    const inlineMd = ranked
      .filter((c) => c.markdown)
      .map((c) => `--- ${shortHost(c.url)} ---\n${c.markdown}`)
      .join("\n\n");
    const snippets = snippetsBlock(ranked);
    let combined = [snippets, inlineMd].filter(Boolean).join("\n\n");
    if (!inlineMd) {
      const md = await scrapeMarkdown(fc, ranked[0].url, emit, etapa);
      if (md) combined = [snippets, md].filter(Boolean).join("\n\n");
    }
    if (!combined) return null;
    const ext = await extractWithAI(combined, ranked[0].url, etapa, municipio, uf, emit);
    if (ext && hasUsefulContact(ext)) return { ext, url: ranked[0].url };
    return null;
  }

  emit("warn", "fallback", "Caindo para contato geral da prefeitura");
  emit("info", "geral", "Estágio D1 — procurando um contato geral da prefeitura");
  const r2 = await runFallback(
    "geral",
    `secretaria geral prefeitura ${municipio} ${uf} contato e-mail telefone ouvidoria`,
  );
  if (r2) {
    emit("success", "geral", "Achei um contato geral utilizável");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "geral",
      secretario: nomeSecretario ?? r2.ext.secretario,
      cargo: r2.ext.cargo,
      emails: r2.ext.emails,
      telefones: r2.ext.telefones,
      fonte: fonteLabel("geral"),
      fonteUrl: r2.url,
      contexto: r2.ext.contexto ?? "Contato geral da prefeitura (sem dados da Educação)",
      nomeFonte: nomeSecretario ? nomeFonte : null,
      dataReferencia: r2.ext.dataReferencia ?? dataReferenciaGlobal,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  emit("warn", "fallback", "Sem contato geral utilizável — última tentativa: gabinete do prefeito");
  emit("info", "gabinete", "Estágio D2 — procurando o gabinete do prefeito");
  const r3 = await runFallback(
    "gabinete",
    `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`,
  );
  if (r3) {
    emit("success", "gabinete", "Achei contato no gabinete do prefeito");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "gabinete",
      secretario: nomeSecretario ?? r3.ext.secretario,
      cargo: r3.ext.cargo,
      emails: r3.ext.emails,
      telefones: r3.ext.telefones,
      fonte: fonteLabel("gabinete"),
      fonteUrl: r3.url,
      contexto: r3.ext.contexto ?? "Contato do gabinete do prefeito",
      nomeFonte: nomeSecretario ? nomeFonte : null,
      dataReferencia: r3.ext.dataReferencia ?? dataReferenciaGlobal,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  // Se ao menos descobrimos o nome, devolve como parcial
  if (nomeSecretario) {
    emit("warn", "final", "Só consegui descobrir o nome — devolvendo parcial");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "educacao",
      secretario: nomeSecretario,
      cargo: null,
      emails: [],
      telefones: [],
      fonte: (nomeFonte as string | null) === "diario" ? "Querido Diário" : "Site oficial",
      fonteUrl: urlSiteEducacao,
      contexto: "Nome identificado, mas não localizamos e-mail/telefone associados.",
      nomeFonte,
      dataReferencia: dataReferenciaGlobal,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  emit("error", "final", "Não encontrei nada utilizável em nenhuma das etapas");
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

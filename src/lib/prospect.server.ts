// Pipeline "Google-first" (Alpha v0.11).
// Princípio: snippet primeiro, scrape só se precisar, Diário só se sobrar tempo.
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

type Extracted = {
  secretario: string | null;
  cargo: string | null;
  emails: string[];
  telefones: string[];
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

/** Busca no Google via Firecrawl. Padrão: SEM scrape (snippet-only) — barato e rápido. */
async function googleSearch(
  fc: Firecrawl,
  query: string,
  emit: Emit,
  etapa: EtapaTag,
  opts: { limit?: number; tbs?: string; withScrape?: boolean } = {},
): Promise<SearchCandidate[]> {
  const { limit = 10, tbs, withScrape = false } = opts;
  const tag = `${withScrape ? "search+scrape" : "search (snippet-only)"}${tbs ? ` [${tbs}]` : ""}`;
  emit("info", etapa, `Google via Firecrawl ${tag}: "${query}"`);
  try {
    const baseOpts: { limit: number; tbs?: string; scrapeOptions?: { formats: ("markdown" | "html")[]; onlyMainContent?: boolean } } = { limit };
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
    emit("info", etapa, `Recebi ${cands.length} resultado(s) do Google`, {
      candidatos: cands.slice(0, 5).map((c) => ({
        url: c.url,
        snippet: `${c.title} — ${c.description}`.slice(0, 220),
      })),
    });
    return cands;
  } catch (e) {
    emit("error", etapa, "Erro na busca do Firecrawl", String(e));
    return [];
  }
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
    return -s;
  };
  return [...cands].sort((a, b) => score(a) - score(b));
}

async function scrapeMarkdown(
  fc: Firecrawl,
  url: string,
  emit: Emit,
  etapa: EtapaTag,
): Promise<string | null> {
  emit("info", etapa, `Baixando ${shortHost(url)} (fetch nativo)...`);
  const native = await fetchHtml(url, {
    emit: (msg, data) => emit("info", etapa, msg, data),
  });
  if (native.ok) {
    const md = htmlToMarkdown(native.html);
    if (md.replace(/\s+/g, " ").trim().length >= 200) {
      emit("success", etapa, `Página baixada direto (${(native.bytes / 1024).toFixed(1)} KB → ${md.length} chars markdown)`, { via: "native" });
      return md.slice(0, 18000);
    }
    emit("warn", etapa, "HTML nativo curto — caindo para Firecrawl");
  } else {
    emit("warn", etapa, `Fetch nativo falhou (${native.reason}) — caindo para Firecrawl`);
  }
  try {
    const res = await fc.scrape(url, { formats: ["markdown"], onlyMainContent: true });
    const md =
      (res as { markdown?: string }).markdown ??
      (res as { data?: { markdown?: string } }).data?.markdown ??
      null;
    if (!md || md.length < 50) return null;
    emit("success", etapa, `Página lida via Firecrawl (${md.length} chars)`);
    return md.slice(0, 18000);
  } catch (e) {
    emit("error", etapa, "Erro no scrape do Firecrawl", String(e));
    return null;
  }
}

async function extractWithAI(
  conteudo: string,
  url: string,
  etapa: Hierarquia,
  municipio: string,
  uf: string,
  emit: Emit,
  opts: { nomeAlvo?: string | null; diarioBlock?: string; modo?: "snippets" | "site" } = {},
): Promise<Extracted | null> {
  const { nomeAlvo = null, diarioBlock = "", modo = "site" } = opts;
  const provider = getProvider();

  const focoEtapa = nomeAlvo
    ? `Extrair E-MAIL e/ou TELEFONE vinculados a "${nomeAlvo}" (Secretaria de Educação que ele(a) chefia).`
    : etapa === "educacao"
      ? "Secretaria Municipal de Educação — nome do(a) Secretário(a) ATUAL e e-mails/telefones dela ou da secretaria."
      : etapa === "geral"
        ? "Contato institucional GERAL da prefeitura (ouvidoria, fale-conosco, telefone/e-mail principal)."
        : "Contato do Gabinete do Prefeito (último recurso).";

  const hints = extractContactsRegex(conteudo);
  const hintsBlock =
    hints.emails.length || hints.telefones.length
      ? `\nPISTAS pré-extraídas por regex (só use se também aparecerem no texto):\n  e-mails: ${hints.emails.join(", ") || "—"}\n  telefones: ${hints.telefones.join(", ") || "—"}\n`
      : "";

  const anoAtual = new Date().getFullYear();
  const fonteLabel = modo === "snippets" ? "snippets do Google" : "página oficial";
  const prompt = `Você extrai contatos institucionais da prefeitura de ${municipio}/${uf} a partir de ${fonteLabel}.
Hoje é ${new Date().toISOString().slice(0, 10)} (ano corrente: ${anoAtual}).

ALVO: Secretaria Municipal de Educação de ${municipio}/${uf} — NOME do(a) Secretário(a) ATUAL + E-MAIL + TELEFONE.

${nomeAlvo ? `NOME-ALVO CONFIRMADO: "${nomeAlvo}". Priorize contatos vinculados a essa pessoa.\n` : ""}FOCO (${etapa}): ${focoEtapa}

REGRAS:
- NUNCA invente. Só extraia o que aparece LITERALMENTE no texto/snippets.
- "secretario" só com nome de pessoa real citada como responsável pela Educação.
- E-mails/telefones precisam aparecer literalmente. Telefones BR com DDD quando possível.
- "confianca" = "alta" só quando o alvo está claramente identificado.

REGRAS DE ATUALIDADE (CRÍTICO):
- Se aparecer mais de um nome, escolha o ATUAL — o mais recentemente empossado (pistas: "nomeado", "empossado", "tomou posse", "a partir de DD/MM/AAAA", data mais recente, ${anoAtual}).
- Snippets do Google geralmente refletem o titular ATUAL — prefira-os ao Diário Oficial quando houver conflito, salvo se o trecho do diário for claramente mais recente.
- Se houver exoneração/troca, ignore o nome antigo.
- Preencha "dataReferencia" com data/mês/ano da evidência (ex.: "2025-11", "abril/2025", "${anoAtual}"); senão null.

URL: ${url}
${diarioBlock}${hintsBlock}
Conteúdo:
"""
${conteudo}
"""

Responda APENAS com JSON válido seguindo o schema.`;
  emit("info", etapa, `IA ${modo === "snippets" ? "(snippets)" : "(página)"} extraindo nome + contato...`, { pistas: hints });
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
      `IA respondeu — secretário: ${out.secretario ?? "—"} · ${out.emails.length} email · ${out.telefones.length} tel · confiança ${out.confianca}${out.dataReferencia ? ` · ref ${out.dataReferencia}` : ""}`,
      out,
    );
    return out;
  } catch (e) {
    const err = e as { message?: string };
    emit("error", etapa, "IA falhou — tentando regex como fallback", { message: err?.message });
    if (hints.emails.length || hints.telefones.length) {
      return {
        secretario: nomeAlvo ?? null,
        cargo: null,
        emails: hints.emails.slice(0, 5),
        telefones: hints.telefones.slice(0, 5),
        contexto: "IA falhou — contatos por regex",
        confianca: "baixa",
        dataReferencia: null,
      };
    }
    return null;
  }
}

function hasUsefulContact(e: Extracted | null): boolean {
  return !!e && (e.emails.length > 0 || e.telefones.length > 0);
}

function fonteLabel(etapa: Hierarquia) {
  return etapa === "educacao"
    ? "Secretaria de Educação"
    : etapa === "geral"
      ? "Contato geral da prefeitura"
      : "Gabinete do Prefeito (último recurso)";
}

function nomeDoDiario(
  excerpts: DiarioExcerpt[],
): { nome: string; data: string; ageDays: number } | null {
  if (excerpts.length === 0) return null;
  const re =
    /secret[áa]ri[oa](?:\s+municipal)?\s+(?:de\s+)?educa[çc][ãa]o[^.,;:\n]{0,30}?[,:\-–]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+){0,3})/i;
  for (const ex of excerpts) {
    const m = ex.trecho.match(re);
    if (m) return { nome: m[1].trim(), data: ex.data, ageDays: ex.ageDays };
  }
  return null;
}

export async function prospectar(
  municipio: string,
  uf: string,
  onEvent?: (evt: ProgressEvent) => void,
  ibgeId?: number,
  options: { useDiario?: boolean } = {},
): Promise<ProspectResult> {
  const t0 = Date.now();
  const { useDiario = false } = options;

  const emit: Emit = (level, etapa, message, data) => {
    onEvent?.({
      kind: "progress",
      level,
      etapa,
      message,
      data,
      ts: Date.now(),
      elapsedMs: Date.now() - t0,
    });
  };
  const sendFinal = (result: ProspectResult) => {
    onEvent?.({ kind: "final", result, ts: Date.now(), elapsedMs: Date.now() - t0 });
    return result;
  };

  emit("info", "init", `Iniciando ${municipio}/${uf} — pipeline Google-first`);

  const fc = getFirecrawl();
  const anoAtual = new Date().getFullYear();

  // Querido Diário em background, NÃO bloqueia o estágio A.
  let diarioExcerpts: DiarioExcerpt[] = [];
  let diarioBlock = "";
  let diarioNome: { nome: string; data: string; ageDays: number } | null = null;
  let diarioPromise: Promise<void> = Promise.resolve();
  if (useDiario && ibgeId) {
    emit("info", "diario", `Diário Oficial em background (timeout 2s)...`);
    diarioPromise = (async () => {
      const r = await buscarDiario(
        ibgeId,
        '"secretário de educação" OR "secretária de educação" OR "secretario municipal de educação"',
        { size: 3, sinceDays: 180, timeoutMs: 2000 },
      );
      if (!r.ok) {
        emit("warn", "diario", `Diário indisponível (${r.reason}) — seguindo sem ele`);
        return;
      }
      diarioExcerpts = r.excerpts;
      diarioBlock = formatExcerptsForPrompt(diarioExcerpts);
      diarioNome = nomeDoDiario(diarioExcerpts);
      emit("success", "diario", `Diário trouxe ${r.excerpts.length} trecho(s)${diarioNome ? ` · pista: ${diarioNome.nome}` : ""}`);
    })().catch((e) => emit("warn", "diario", `Diário erro: ${String(e)}`));
  } else if (!useDiario) {
    emit("info", "diario", "Querido Diário desligado nesta busca");
  }

  // ===== ESTÁGIO A: 1 busca snippet-only → IA extrai tudo =====
  emit("info", "nome", "Estágio A — 1 busca no Google (snippet-only) + IA");
  const queryA = `secretário OR secretária de educação ${municipio} ${uf} ${anoAtual}`;
  const candsA = await googleSearch(fc, queryA, emit, "nome", { limit: 10, tbs: "qdr:y" });
  const rankedA = preferGov(candsA, (u) => /(educa|secretari)/i.test(u));
  const snippetsA = snippetsBlock(rankedA);
  const topA = rankedA[0] ?? null;

  // Espera só 800ms pelo diário para enriquecer o prompt; senão segue sem.
  if (useDiario) {
    await Promise.race([diarioPromise, new Promise<void>((r) => setTimeout(r, 800))]);
  }

  let nomeSecretario: string | null = null;
  let nomeFonte: ProspectResult["nomeFonte"] = null;
  let dataReferenciaGlobal: string | null = null;
  if (diarioNome && (diarioNome as { ageDays: number }).ageDays <= 365) {
    nomeSecretario = (diarioNome as { nome: string }).nome;
    nomeFonte = "diario";
    dataReferenciaGlobal = (diarioNome as { data: string }).data || null;
    emit("info", "nome", `Pista do diário entrou no prompt: ${nomeSecretario}`);
  }

  let extA: Extracted | null = null;
  if (snippetsA) {
    extA = await extractWithAI(snippetsA, topA?.url ?? "(snippets)", "educacao", municipio, uf, emit, {
      nomeAlvo: nomeSecretario,
      diarioBlock,
      modo: "snippets",
    });
    if (extA?.secretario) {
      // Resolve conflito: prefere IA (snippet) sobre diário se diferentes.
      if (nomeSecretario && extA.secretario.toLowerCase().trim() !== nomeSecretario.toLowerCase().trim()) {
        emit("warn", "nome", `Conflito: diário=${nomeSecretario} / snippet=${extA.secretario} — adotando snippet (mais atual)`);
      }
      nomeSecretario = extA.secretario;
      nomeFonte = "snippet";
      dataReferenciaGlobal = extA.dataReferencia ?? dataReferenciaGlobal;
    }

    // CASO FELIZ: snippet trouxe nome + contato com confiança razoável.
    if (extA && hasUsefulContact(extA) && extA.secretario && extA.confianca !== "baixa") {
      emit("success", "educacao", `✨ Caminho feliz: tudo nos snippets do Google (${Date.now() - t0}ms)`);
      return sendFinal({
        status: "found",
        hierarquia: "educacao",
        secretario: extA.secretario,
        cargo: extA.cargo,
        emails: extA.emails,
        telefones: extA.telefones,
        fonte: "Snippet do Google",
        fonteUrl: topA?.url ?? null,
        contexto: extA.contexto ?? "Extraído direto dos resultados do Google.",
        nomeFonte: "snippet",
        dataReferencia: extA.dataReferencia ?? dataReferenciaGlobal,
      });
    }
  } else {
    emit("warn", "nome", "Busca A não retornou resultados");
  }

  // ===== ESTÁGIO B: se temos nome mas falta contato, 1 busca dirigida pelo nome =====
  if (nomeSecretario && (!extA || !hasUsefulContact(extA))) {
    emit("info", "contato-secretario", `Estágio B — buscando contatos de "${nomeSecretario}"`);
    const queryB = `"${nomeSecretario}" secretaria educação ${municipio} ${uf} e-mail telefone`;
    const candsB = await googleSearch(fc, queryB, emit, "contato-secretario", { limit: 8, tbs: "qdr:y" });
    const rankedB = preferGov(candsB);
    const snippetsB = snippetsBlock(rankedB);
    if (snippetsB) {
      const extB = await extractWithAI(snippetsB, rankedB[0]?.url ?? "(snippets)", "educacao", municipio, uf, emit, {
        nomeAlvo: nomeSecretario,
        modo: "snippets",
      });
      if (extB && hasUsefulContact(extB)) {
        emit("success", "contato-secretario", `✨ Contato vinculado ao nome (${Date.now() - t0}ms)`);
        return sendFinal({
          status: "found",
          hierarquia: "educacao",
          secretario: extB.secretario ?? nomeSecretario,
          cargo: extB.cargo,
          emails: extB.emails,
          telefones: extB.telefones,
          fonte: "Snippet do Google (busca dirigida pelo nome)",
          fonteUrl: rankedB[0]?.url ?? null,
          contexto: extB.contexto ?? `Snippet de busca por "${nomeSecretario}".`,
          nomeFonte,
          dataReferencia: extB.dataReferencia ?? dataReferenciaGlobal,
        });
      }
    }
  }

  // ===== ESTÁGIO C: scrape do top .gov.br da busca A (só agora pagamos esse custo) =====
  if (topA && (!extA || !hasUsefulContact(extA))) {
    emit("info", "educacao", `Estágio C — scrape do site oficial (${shortHost(topA.url)})`);
    const md = await scrapeMarkdown(fc, topA.url, emit, "educacao");
    if (md) {
      const combined = [snippetsA, `### Conteúdo do site\n${md}`].filter(Boolean).join("\n\n");
      const extC = await extractWithAI(combined, topA.url, "educacao", municipio, uf, emit, {
        nomeAlvo: nomeSecretario,
        diarioBlock,
        modo: "site",
      });
      if (extC?.secretario && !nomeSecretario) {
        nomeSecretario = extC.secretario;
        nomeFonte = "site";
        dataReferenciaGlobal = extC.dataReferencia ?? dataReferenciaGlobal;
      }
      if (extC && hasUsefulContact(extC) && (extC.secretario || nomeSecretario)) {
        emit("success", "educacao", `Contato via site oficial (${Date.now() - t0}ms)`);
        return sendFinal({
          status: "found",
          hierarquia: "educacao",
          secretario: extC.secretario ?? nomeSecretario,
          cargo: extC.cargo,
          emails: extC.emails,
          telefones: extC.telefones,
          fonte: fonteLabel("educacao"),
          fonteUrl: topA.url,
          contexto: extC.contexto,
          nomeFonte: nomeFonte ?? "site",
          dataReferencia: extC.dataReferencia ?? dataReferenciaGlobal,
        });
      }
      if (extC && hasUsefulContact(extC)) extA = extC; // guarda como parcial
    }
  }

  // ===== ESTÁGIO D: parcial Educação (sem nome) =====
  if (extA && hasUsefulContact(extA)) {
    emit("success", "educacao", "Contato institucional da Educação (sem vínculo ao nome) — registrando como parcial");
    return sendFinal({
      status: "partial",
      hierarquia: "educacao",
      secretario: nomeSecretario ?? extA.secretario,
      cargo: extA.cargo,
      emails: extA.emails,
      telefones: extA.telefones,
      fonte: fonteLabel("educacao"),
      fonteUrl: topA?.url ?? null,
      contexto: extA.contexto,
      nomeFonte,
      dataReferencia: extA.dataReferencia ?? dataReferenciaGlobal,
    });
  }

  // ===== Fallbacks geral / gabinete (snippet-only) =====
  async function runFallback(etapa: Hierarquia, query: string): Promise<ProspectResult | null> {
    emit("info", etapa, `Fallback ${etapa} — 1 busca snippet-only`);
    const cands = await googleSearch(fc, query, emit, etapa, { limit: 8 });
    const ranked = preferGov(cands);
    if (ranked.length === 0) return null;
    const snippets = snippetsBlock(ranked);
    let ext = await extractWithAI(snippets, ranked[0].url, etapa, municipio, uf, emit, { modo: "snippets" });
    if (!ext || !hasUsefulContact(ext)) {
      // última cartada: scrapeia top 1
      const md = await scrapeMarkdown(fc, ranked[0].url, emit, etapa);
      if (md) {
        const combined = [snippets, `### Site\n${md}`].filter(Boolean).join("\n\n");
        ext = await extractWithAI(combined, ranked[0].url, etapa, municipio, uf, emit, { modo: "site" });
      }
    }
    if (!ext || !hasUsefulContact(ext)) return null;
    return {
      status: "partial",
      hierarquia: etapa,
      secretario: nomeSecretario ?? ext.secretario,
      cargo: ext.cargo,
      emails: ext.emails,
      telefones: ext.telefones,
      fonte: fonteLabel(etapa),
      fonteUrl: ranked[0].url,
      contexto: ext.contexto,
      nomeFonte: nomeSecretario ? nomeFonte : null,
      dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
    };
  }

  emit("warn", "fallback", "Caindo para contato geral da prefeitura");
  const r2 = await runFallback("geral", `prefeitura ${municipio} ${uf} ouvidoria contato e-mail telefone`);
  if (r2) return sendFinal(r2);

  emit("warn", "fallback", "Última tentativa: gabinete do prefeito");
  const r3 = await runFallback("gabinete", `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`);
  if (r3) return sendFinal(r3);

  if (nomeSecretario) {
    emit("warn", "final", "Só consegui o nome — devolvendo parcial");
    return sendFinal({
      status: "partial",
      hierarquia: "educacao",
      secretario: nomeSecretario,
      cargo: null,
      emails: [],
      telefones: [],
      fonte: nomeFonte === "diario" ? "Querido Diário" : "Snippet do Google",
      fonteUrl: topA?.url ?? null,
      contexto: "Nome identificado, mas não localizamos e-mail/telefone associados.",
      nomeFonte,
      dataReferencia: dataReferenciaGlobal,
    });
  }

  emit("error", "final", `Nada utilizável encontrado (${Date.now() - t0}ms)`);
  return sendFinal({
    status: "not_found",
    hierarquia: null,
    secretario: null,
    cargo: null,
    emails: [],
    telefones: [],
    fonte: null,
    fonteUrl: null,
    contexto: "Nenhum contato encontrado.",
  });
}

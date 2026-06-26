// Pipeline ESCALONADO (Alpha v0.12).
// 1) Fecha o NOME atual.  2) Busca contato vinculado ao nome.
// 3) Busca contato institucional da Secretaria (inclui Câmara Municipal).
// 4) Fallback geral → gabinete.
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

// Schema completo — usado nos estágios 2/3/4 (contato).
const ExtractSchema = z.object({
  secretario: z.string().nullable().optional().default(null),
  cargo: z.string().nullable().optional().default(null),
  emails: z.array(z.string()).optional().default([]),
  telefones: z.array(z.string()).optional().default([]),
  contexto: z.string().nullable().optional().default(null),
  confianca: ConfiancaLoose.default("baixa"),
  dataReferencia: z.string().nullable().optional().default(null),
  horarioAtendimento: z.string().nullable().optional().default(null),
});

// Schema reduzido — usado SOMENTE no Estágio 1 (nome). Sem e-mails/telefones.
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
  horarioAtendimento: string | null;
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

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Timeout duro genérico — resolve null se estourar o limite.
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  emit?: Emit,
  etapa?: EtapaTag,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutP = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (emit && etapa) emit("warn", etapa, `⏱ Timeout ${ms}ms em ${label} — seguindo`);
      resolve(null);
    }, ms);
  });
  try {
    return (await Promise.race([promise, timeoutP])) as T | null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Municípios "grandes" — se anti-contam zerar e-mails, NÃO devolver parcial vazio
// (forçar próximo fallback). Mantém comportamento atual para os demais.
const LARGE_MUNI_SLUGS = new Set([
  "curitiba","saopaulo","riodejaneiro","belohorizonte","salvador","fortaleza",
  "manaus","recife","portoalegre","goiania","florianopolis","campinas","maringa",
]);

type SearchCandidate = {
  url: string;
  title: string;
  description: string;
  markdown: string | null;
};

function isBlockedHost(url: string): boolean {
  return /(?:instagram\.com|facebook\.com|youtube\.com|tiktok\.com|twitter\.com|x\.com)/i.test(url);
}

/** Busca no Google via Firecrawl. Padrão: SEM scrape (snippet-only). */
async function googleSearch(
  fc: Firecrawl,
  query: string,
  emit: Emit,
  etapa: EtapaTag,
  opts: { limit?: number; tbs?: string; withScrape?: boolean } = {},
): Promise<SearchCandidate[]> {
  const { limit = 10, tbs, withScrape = false } = opts;
  const tag = `${withScrape ? "search+scrape" : "search (snippet-only)"}${tbs ? ` [${tbs}]` : ""}`;
  emit("info", etapa, `Google ${tag}: "${query}"`);
  try {
    const baseOpts: { limit: number; tbs?: string; scrapeOptions?: { formats: ("markdown" | "html")[]; onlyMainContent?: boolean } } = { limit };
    if (tbs) baseOpts.tbs = tbs;
    if (withScrape) baseOpts.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
    const res = await fc.search(query, baseOpts as Parameters<Firecrawl["search"]>[1]);
    const resObj = res as { web?: Array<{ url: string; title?: string; description?: string; markdown?: string }> };
    const hasWebProp = Object.prototype.hasOwnProperty.call(resObj, "web");
    const web = resObj.web ?? [];
    if (!hasWebProp || web.length === 0) {
      let rawDump = "";
      try {
        rawDump = JSON.stringify(res).slice(0, 500);
      } catch {
        rawDump = String(res).slice(0, 500);
      }
      emit("warn", etapa, `Firecrawl search retornou vazio (hasWeb=${hasWebProp}, len=${web.length}) — payload bruto:`, { query, rawPreview: rawDump });
    }
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

/** googleSearch com timeout duro — devolve [] se estourar. */
async function gSearch(
  fc: Firecrawl,
  query: string,
  emit: Emit,
  etapa: EtapaTag,
  opts: { limit?: number; tbs?: string; withScrape?: boolean; timeoutMs?: number } = {},
): Promise<SearchCandidate[]> {
  const { timeoutMs = 8000, ...rest } = opts;
  const r = await withTimeout(googleSearch(fc, query, emit, etapa, rest), timeoutMs, `googleSearch("${query.slice(0, 60)}")`, emit, etapa);
  return r ?? [];
}

/** scrapeMarkdown com timeout duro — devolve null se estourar. */
async function gScrape(
  fc: Firecrawl,
  url: string,
  emit: Emit,
  etapa: EtapaTag,
  opts: { timeoutMs?: number; hardTimeoutMs?: number } = {},
): Promise<string | null> {
  const hard = opts.hardTimeoutMs ?? 8000;
  const inner: { timeoutMs?: number } = {};
  if (opts.timeoutMs !== undefined) inner.timeoutMs = opts.timeoutMs;
  return withTimeout(scrapeMarkdown(fc, url, emit, etapa, inner), hard, `scrapeMarkdown(${shortHost(url)})`, emit, etapa);
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
  const OTHER_SECRETARIAS = /(esporte|saude|sa[uú]de|obras|tr[âa]nsito|transito|turismo|cultura|assistencia|assist[êe]ncia|meio[-_.\s]?ambiente|fazenda|planejamento|habitacao|habita[çc][ãa]o|agricultura)/i;
  const score = (c: SearchCandidate) => {
    let s = 0;
    const blob = `${c.url} ${c.title ?? ""} ${c.description ?? ""}`;
    if (/\.gov\.br/i.test(c.url)) s += 10;
    if (/\.leg\.br/i.test(c.url)) s += 6;
    if (extra && extra(c.url)) s += 5;
    if (c.markdown) s += 2;
    // Penaliza fortemente páginas claramente de OUTRAS secretarias.
    if (OTHER_SECRETARIAS.test(blob) && !/(educa|seduc|sme|smed)/i.test(blob)) s -= 8;
    return -s;
  };
  return [...cands].sort((a, b) => score(a) - score(b));
}

function dedupeByUrl(arr: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const out: SearchCandidate[] = [];
  for (const c of arr) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

// ---- Seleção/ranking de e-mails ----
const GENERIC_LOCAL = /^(ouvidoria|faleconosco|fale-conosco|falecom|contato|imprensa|gabinete|prefeito|atendimento|protocolo|rh)@/i;
const EDUCATION_LOCAL = /^(seduc|sme|smed|educacao|educa|secretariadeeducacao|secretaria\.educacao)/i;
// Escolas/CMEIs/creches/conselhos — NUNCA devem virar contato da Secretaria.
const SCHOOL_LOCAL = /^(escola|colegio|col[ée]gio|emef|emei|emeif|emeief|cmei|cmeb|cei|creche|biblioteca|cras|cmdca|conselho)/i;
const SCHOOL_DOMAIN = /(^|\.)(escola|colegio|cmei|emei|emef|creche)\./i;

function isSchoolEmail(e: string): boolean {
  const [local = "", domain = ""] = e.toLowerCase().split("@");
  return SCHOOL_LOCAL.test(local) || SCHOOL_DOMAIN.test(domain);
}

function rankEmails(emails: string[], municipio: string, uf: string, topHost?: string): string[] {
  const slug = slugify(municipio);
  const ufLow = uf.toLowerCase();
  const topHostLow = (topHost ?? "").toLowerCase();
  const score = (e: string) => {
    const [local = "", domain = ""] = e.toLowerCase().split("@");
    let s = 0;
    if (EDUCATION_LOCAL.test(`${local}@`) || /(seduc|educa)/i.test(local)) s += 20;
    // Bônus para local part EXATA (sem ramal/sufixo) — seduc@ > seduc_dir_*@
    if (/^(seduc|sme|smed|educacao)$/.test(local)) s += 10;
    // Penalidade para ramais internos: token_edu seguido de underscore (seduc_dir_*, educacao_geral_*)
    if (/^(seduc|sme|smed|educacao|educa)_/.test(local)) s -= 5;
    if (/^educacao\./i.test(domain)) s += 8;
    if (domain.includes(`${slug}.${ufLow}.gov.br`) || domain.endsWith(`.${slug}.${ufLow}.gov.br`)) s += 6;
    if (domain.endsWith(".gov.br")) s += 3;
    if (topHostLow && (domain === topHostLow || topHostLow.endsWith(domain) || domain.endsWith(topHostLow))) s += 5;
    if (GENERIC_LOCAL.test(e)) s -= 15;
    if (isSchoolEmail(e)) s -= 100;
    return -s;
  };
  const uniq = Array.from(new Set(emails.map((e) => e.trim()).filter(Boolean)));
  return uniq.sort((a, b) => score(a) - score(b));
}

/**
 * Filtra e-mails para o resultado final.
 * - Remove SEMPRE e-mails de escolas/CMEIs (não são contato da Secretaria).
 * - Se houver e-mail bom (não-genérico), descarta os genéricos.
 * Retorna [] se sobrar apenas lixo (chamador então tenta próximo estágio).
 */
function filterEmailsForFinal(emails: string[], municipio: string, uf: string, topHost?: string): string[] {
  const ranked = rankEmails(emails, municipio, uf, topHost).filter((e) => !isSchoolEmail(e));
  const good = ranked.filter((e) => !GENERIC_LOCAL.test(e));
  return good.length > 0 ? good : ranked;
}

// ---- Validação anti-alucinação: manter só o que aparece literalmente no texto-fonte ----
function digits(s: string): string {
  return s.replace(/\D+/g, "");
}

function filterPresent(extracted: Extracted, source: string, municipio?: string, uf?: string): Extracted {
  const lower = source.toLowerCase();
  let emails = extracted.emails.filter((e) => lower.includes(e.toLowerCase().trim()));

  // Anti-contaminação: e-mail .gov.br tem que conter o SLUG do município-alvo
  // no domínio. Se não contém, é de outro município mesmo dentro da UF correta
  // (ex.: educacao@santoantoniodaplatina.pr.gov.br aparecendo em busca de Curitiba/PR).
  // Mantém o suspeito só se for o único e-mail disponível (último recurso).
  if (municipio && uf && emails.length > 0) {
    const slug = slugify(municipio);
    const isForeignGov = (e: string) => {
      const domain = (e.split("@")[1] ?? "").toLowerCase();
      if (!domain.endsWith(".gov.br")) return false;
      return !domain.includes(slug);
    };
    const cleaned = emails.filter((e) => !isForeignGov(e));
    if (cleaned.length > 0) emails = cleaned;
    // se filtrou tudo, mantém o original (último recurso)
  }

  const sourceDigits = digits(source);
  const telefones = extracted.telefones.filter((t) => {
    const d = digits(t);
    return d.length >= 8 && sourceDigits.includes(d);
  });
  return { ...extracted, emails, telefones };
}

async function scrapeMarkdown(
  fc: Firecrawl,
  url: string,
  emit: Emit,
  etapa: EtapaTag,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  emit("info", etapa, `Baixando ${shortHost(url)} (fetch nativo)...`);
  const native = await fetchHtml(url, {
    timeoutMs: opts.timeoutMs,
    emit: (msg, data) => emit("info", etapa, msg, data),
  });
  if (native.ok) {
    const md = htmlToMarkdown(native.html, native.finalUrl);
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

// ===== Estágio 1: extrai SOMENTE o nome atual =====
async function extractNomeWithAI(
  conteudo: string,
  url: string,
  municipio: string,
  uf: string,
  emit: Emit,
  opts: { diarioBlock?: string } = {},
): Promise<NomeOnly | null> {
  const { diarioBlock = "" } = opts;
  const provider = getProvider();
  const anoAtual = new Date().getFullYear();
  const prompt = `Você identifica o(a) SECRETÁRIO(A) MUNICIPAL DE EDUCAÇÃO ATUAL de ${municipio}/${uf}.
Hoje é ${new Date().toISOString().slice(0, 10)} (ano corrente: ${anoAtual}).

OBJETIVO ÚNICO desta etapa: NOME e CARGO da pessoa. NÃO devolva e-mail nem telefone.

REGRAS:
- NUNCA invente. Só extraia o que aparece LITERALMENTE no texto/snippets.
- "secretario" só com nome de pessoa real citada como responsável pela Educação.
- Se houver mais de um nome, escolha o ATUAL — mais recentemente empossado (pistas: "nomeado", "empossado", "tomou posse", "a partir de DD/MM/AAAA", data mais recente, ${anoAtual}).
- Se houver exoneração/troca, ignore o nome antigo.
- Snippets do Google geralmente refletem o titular ATUAL — prefira-os ao Diário Oficial quando houver conflito, salvo se o trecho do diário for claramente mais recente.
- "dataReferencia": data/mês/ano da evidência (ex.: "${anoAtual}-11", "abril/${anoAtual}"); senão null.
- "confianca" = "alta" só quando o nome ATUAL está claramente identificado.
- Se encontrar um nome em snippets de domínio ".gov.br" do próprio município, marque confiança como "alta" automaticamente, mesmo que o snippet seja curto.
- Aceite o nome se ele aparecer ao menos 2 vezes nos snippets combinados, mesmo sem data explícita — nesse caso, confiança "media" ou "alta".
- Antes de retornar confiança "baixa", releia mentalmente APENAS os snippets de ".gov.br" isolados e tente extrair novamente; só desista se ainda assim não houver evidência clara.

URL: ${url}
${diarioBlock}
Conteúdo:
"""
${conteudo}
"""

Responda APENAS com JSON válido seguindo o schema.`;
  emit("info", "nome", "IA extraindo NOME atual (sem contatos)...");
  try {
    const { object } = await generateObject({
      model: provider("google/gemini-3-flash-preview"),
      schema: NomeSchema,
      prompt,
    });
    const out = object as NomeOnly;
    emit(
      out.confianca === "baixa" ? "warn" : "success",
      "nome",
      `Nome: ${out.secretario ?? "—"} · confiança ${out.confianca}${out.dataReferencia ? ` · ref ${out.dataReferencia}` : ""}`,
      out,
    );
    return out;
  } catch (e) {
    emit("error", "nome", "IA falhou ao extrair nome", String(e));
    return null;
  }
}

// ===== Estágios 2/3/4: extrai contatos =====
async function extractWithAI(
  conteudo: string,
  url: string,
  etapa: Hierarquia,
  municipio: string,
  uf: string,
  emit: Emit,
  opts: {
    nomeAlvo?: string | null;
    diarioBlock?: string;
    modo?: "snippets" | "site";
    topHost?: string;
  } = {},
): Promise<Extracted | null> {
  const { nomeAlvo = null, diarioBlock = "", modo = "site", topHost } = opts;
  const provider = getProvider();

  const focoEtapa = nomeAlvo
    ? `E-MAIL e TELEFONE vinculados a "${nomeAlvo}" / Secretaria de Educação que ele(a) chefia.`
    : etapa === "educacao"
      ? "E-MAIL e TELEFONE institucionais da Secretaria Municipal de Educação."
      : etapa === "geral"
        ? "Contato institucional GERAL da prefeitura (ouvidoria, fale-conosco, telefone/e-mail principal)."
        : "Contato do Gabinete do Prefeito (último recurso).";

  const hints = extractContactsRegex(conteudo);
  const hintsBlock =
    hints.emails.length || hints.telefones.length
      ? `\nPISTAS pré-extraídas por regex (só use se também aparecerem no texto):\n  e-mails: ${hints.emails.join(", ") || "—"}\n  telefones: ${hints.telefones.join(", ") || "—"}\n`
      : "";

  const fonteLbl = modo === "snippets" ? "snippets do Google" : "página oficial";
  const prompt = `Você extrai CONTATOS institucionais da Secretaria de Educação de ${municipio}/${uf} a partir de ${fonteLbl}.

${nomeAlvo ? `NOME CONFIRMADO: "${nomeAlvo}". Priorize contatos vinculados a essa pessoa/secretaria.\n` : ""}FOCO (${etapa}): ${focoEtapa}

REGRAS GERAIS:
- NUNCA invente. Só extraia e-mails/telefones que aparecem LITERALMENTE no texto/snippets.
- Telefones BR com DDD quando possível. Não devolva números soltos sem contexto de telefone.
- "confianca" = "alta" só quando o contato está claramente ligado à Secretaria de Educação${nomeAlvo ? " ou ao(à) titular" : ""}.

REGRAS DE E-MAIL (CRÍTICO — não erre isso):
- PRIORIZE e-mails específicos da Educação: começam com "seduc@", "sme@", "smed@", "educacao@", "educa@", ou domínio "educacao.{municipio}.gov.br".
- PROIBIDO devolver e-mail de ESCOLA, COLÉGIO, EMEF, EMEI, CMEI, CRECHE, CEI ou Conselho/Biblioteca. Esses são unidades, NÃO são a Secretaria. Se só houver e-mail de escola/CMEI, devolva "emails": [] e deixe o próximo estágio buscar o contato geral.
- EVITE e-mails genéricos da prefeitura ("ouvidoria@", "faleconosco@", "contato@", "imprensa@", "gabinete@", "prefeito@") — só os devolva se forem os ÚNICOS presentes.
- Quando houver um e-mail bom de Educação no texto, NÃO inclua os genéricos.
- Ordene "emails" do MAIS ESPECÍFICO (Educação) para o MAIS GENÉRICO.
- Mesma regra vale para telefones: prefira o ramal/linha direta da Secretaria de Educação ao da central da prefeitura.

HORÁRIO DE ATENDIMENTO:
- Preencha "horarioAtendimento" SOMENTE se aparecer literalmente no texto (ex.: "Segunda a Sexta, 8h às 17h", "Seg–Sex 08:00–17:00"). Senão null.

DATA: preencha "dataReferencia" (ex.: "${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}") quando o texto indicar; senão null.

URL: ${url}
${diarioBlock}${hintsBlock}
Conteúdo:
"""
${conteudo}
"""

Responda APENAS com JSON válido seguindo o schema.`;
  emit("info", etapa, `IA ${modo === "snippets" ? "(snippets)" : "(página)"} extraindo contatos${nomeAlvo ? ` de "${nomeAlvo}"` : ""}...`, { pistas: hints });
  try {
    const { object } = await generateObject({
      model: provider("google/gemini-3-flash-preview"),
      schema: ExtractSchema,
      prompt,
    });
    let out = object as Extracted;
    if (nomeAlvo && !out.secretario) out.secretario = nomeAlvo;
    // Anti-alucinação: descarta o que não aparece literalmente.
    const beforeE = out.emails.length;
    const beforeT = out.telefones.length;
    out = filterPresent(out, conteudo, municipio, uf);
    if (beforeE !== out.emails.length || beforeT !== out.telefones.length) {
      emit("warn", etapa, `Descartei ${beforeE - out.emails.length} e-mail(s) e ${beforeT - out.telefones.length} tel sem correspondência literal no texto`);
    }
    // Filtro escola/CMEI + ranking final (Educação primeiro, genéricos por último).
    const beforeSchool = out.emails.length;
    if (out.emails.length > 0) {
      out.emails = filterEmailsForFinal(out.emails, municipio, uf, topHost);
    }
    if (beforeSchool !== out.emails.length) {
      emit("warn", etapa, `Descartei ${beforeSchool - out.emails.length} e-mail(s) de escola/CMEI`);
    }
    emit(
      out.confianca === "baixa" ? "warn" : "success",
      etapa,
      `IA respondeu — ${out.emails.length} email · ${out.telefones.length} tel · confiança ${out.confianca}${out.horarioAtendimento ? ` · 🕒` : ""}${out.dataReferencia ? ` · ref ${out.dataReferencia}` : ""}`,
      out,
    );
    return out;
  } catch (e) {
    const err = e as { message?: string };
    emit("error", etapa, "IA falhou — tentando regex como fallback", { message: err?.message });
    if (hints.emails.length || hints.telefones.length) {
      const fallback: Extracted = {
        secretario: nomeAlvo ?? null,
        cargo: null,
        emails: filterEmailsForFinal(hints.emails.slice(0, 8), municipio, uf, topHost),
        telefones: hints.telefones.slice(0, 5),
        contexto: "IA falhou — contatos por regex",
        confianca: "baixa",
        dataReferencia: null,
        horarioAtendimento: null,
      };
      return fallback;
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
    : etapa === "camara"
      ? "Câmara Municipal (fallback)"
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

  emit("info", "init", `Iniciando ${municipio}/${uf} — pipeline ESCALONADO (nome → contato)`);

  const fc = getFirecrawl();
  const anoAtual = new Date().getFullYear();
  const slug = slugify(municipio);
  const ufLow = uf.toLowerCase();

  // Pool global de snippets — reaproveitado entre estágios.
  const snippetPool: SearchCandidate[] = [];
  const seenUrls = new Set<string>();
  const addToPool = (cands: SearchCandidate[]) => {
    for (const c of cands) {
      if (!c?.url || seenUrls.has(c.url)) continue;
      seenUrls.add(c.url);
      snippetPool.push(c);
    }
  };

  // Diário Oficial em background.
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

  // ============================================================
  // ESTÁGIO 1 — NOME ATUAL (apenas nome, sem contato)
  // ============================================================
  emit("info", "nome", "Estágio 1 — identificar NOME atual do(a) Secretário(a) de Educação");
  const queryNomeA = `prefeitura municipal ${municipio} ${uf} secretaria de educação secretário atual`;
  const queryNomeB = `secretário OR secretária de educação ${municipio} ${uf} ${anoAtual} atual`;
  const queryNomeC = `site:${slug}.${ufLow}.gov.br secretaria educação secretário`;
  const [candsNomeA, candsNomeB, candsNomeC] = await Promise.all([
    gSearch(fc, queryNomeA, emit, "nome", { limit: 8, tbs: "qdr:y", timeoutMs: 8000 }),
    gSearch(fc, queryNomeB, emit, "nome", { limit: 6, tbs: "qdr:y", timeoutMs: 8000 }),
    gSearch(fc, queryNomeC, emit, "nome", { limit: 5, tbs: "qdr:y", timeoutMs: 8000 }),
  ]);
  // Fallback de domínio: se o domínio padrão {slug}.{uf}.gov.br não retornou nada,
  // tenta {uf}.gov.br com o nome do município.
  let candsNomeCfb: SearchCandidate[] = [];
  if (candsNomeC.length === 0) {
    const queryNomeCfb = `site:${ufLow}.gov.br "${municipio}" secretaria educação secretário`;
    candsNomeCfb = await gSearch(fc, queryNomeCfb, emit, "nome", { limit: 5, tbs: "qdr:y", timeoutMs: 8000 });
  }
  // Priorizar resultados do domínio oficial do município (queryNomeC/fb) ANTES de A/B.
  const candsNome = dedupeByUrl([...candsNomeC, ...candsNomeCfb, ...candsNomeA, ...candsNomeB]);
  addToPool(candsNome);
  const rankedNome = preferGov(candsNome, (u) => /(educa|secretari)/i.test(u));
  const snippetsNome = snippetsBlock(rankedNome);
  const topNome = rankedNome[0] ?? null;
  const topHost = topNome ? shortHost(topNome.url) : undefined;

  if (useDiario) {
    await Promise.race([diarioPromise, new Promise<void>((r) => setTimeout(r, 800))]);
  }

  let nomeSecretario: string | null = null;
  let cargoSecretario: string | null = null;
  let nomeFonte: ProspectResult["nomeFonte"] = null;
  let dataReferenciaGlobal: string | null = null;

  if (diarioNome && (diarioNome as { ageDays: number }).ageDays <= 365) {
    nomeSecretario = (diarioNome as { nome: string }).nome;
    nomeFonte = "diario";
    dataReferenciaGlobal = (diarioNome as { data: string }).data || null;
    emit("info", "nome", `Pista do diário entrou no prompt: ${nomeSecretario}`);
  }

  if (snippetsNome) {
    const nomeRes = await extractNomeWithAI(snippetsNome, topNome?.url ?? "(snippets)", municipio, uf, emit, {
      diarioBlock,
    });

    // ---- Promoção determinística da confiança (não depende da IA) ----
    // Conta ocorrências literais do nome nos snippets do Google. Se aparecer em
    // .gov.br do próprio município → "alta". Se aparecer em ≥2 snippets → "media".
    // Só descarta se confiança ficar "baixa" E o nome não aparecer em nenhum snippet.
    let confianca: "alta" | "media" | "baixa" = nomeRes?.confianca ?? "baixa";
    let appearsCount = 0;
    let appearsInOwnGov = false;
    if (nomeRes?.secretario) {
      const nomeLow = nomeRes.secretario.toLowerCase().trim();
      for (const c of rankedNome) {
        const blob = `${c.title ?? ""} ${c.description ?? ""}`.toLowerCase();
        if (!blob.includes(nomeLow)) continue;
        appearsCount += 1;
        const host = shortHost(c.url).toLowerCase();
        if (/\.gov\.br$/.test(host) && host.includes(slug)) appearsInOwnGov = true;
      }
      if (appearsInOwnGov) confianca = "alta";
      else if (appearsCount >= 2 && confianca === "baixa") confianca = "media";
      emit("info", "nome", `Confiança ajustada: IA=${nomeRes.confianca} → ${confianca} (aparições=${appearsCount}, govPróprio=${appearsInOwnGov})`);
    }

    const aceitaNome = !!nomeRes?.secretario && (confianca !== "baixa" || appearsCount >= 1);
    if (nomeRes?.secretario && !aceitaNome) {
      emit("warn", "nome", `Descartando nome "${nomeRes.secretario}" — não aparece em nenhum snippet e confiança baixa`);
    }
    if (aceitaNome && nomeRes?.secretario) {
      if (nomeSecretario && nomeRes.secretario.toLowerCase().trim() !== nomeSecretario.toLowerCase().trim()) {
        emit("warn", "nome", `Conflito: diário=${nomeSecretario} / snippet=${nomeRes.secretario} — adotando snippet (mais atual)`);
      }
      nomeSecretario = nomeRes.secretario;
      cargoSecretario = nomeRes.cargo ?? cargoSecretario;
      nomeFonte = "snippet";
      dataReferenciaGlobal = nomeRes.dataReferencia ?? dataReferenciaGlobal;
    }
  } else {
    emit("warn", "nome", "Busca de nome não retornou resultados");
  }

  if (nomeSecretario) {
    emit("success", "nome", `Estágio 1 OK — nome atual: ${nomeSecretario} (fonte: ${nomeFonte})`);
  } else {
    emit("warn", "nome", "Estágio 1 não fechou o nome — seguirei para contato institucional");
  }

  // ============================================================
  // ESTÁGIO 1.5 — Scrape oportunista do topo (se for página da Secretaria)
  // ============================================================
  const looksLikeSeducPage = (c?: SearchCandidate | null) => {
    if (!c) return false;
    const text = `${c.url} ${c.title ?? ""} ${c.description ?? ""}`.toLowerCase();
    return (
      /\.gov\.br|\.leg\.br/.test(c.url) &&
      /(secretaria|secretári|seduc|sme|smed|educa)/.test(text)
    );
  };
  if (looksLikeSeducPage(topNome)) {
    emit("info", "educacao", `Estágio 1.5 — scrape oportunista de ${topHost}`);
    const md = await gScrape(fc, topNome!.url, emit, "educacao", { timeoutMs: 4000, hardTimeoutMs: 4000 });
    if (md) {
      const combined = `### Site\n${md}\n\n### Snippets\n${snippetsBlock(rankedNome)}`;
      const ext = await extractWithAI(combined, topNome!.url, "educacao", municipio, uf, emit, {
        nomeAlvo: nomeSecretario,
        diarioBlock,
        modo: "site",
        topHost,
      });
      if (ext && hasUsefulContact(ext)) {
        const hasGood = ext.emails.some((e) => !GENERIC_LOCAL.test(e)) || ext.telefones.length > 0;
        if (hasGood) {
          emit("success", "educacao", `✨ Contato via página oficial topo (${Date.now() - t0}ms)`);
          return sendFinal({
            status: "found",
            hierarquia: "educacao",
            secretario: ext.secretario ?? nomeSecretario,
            cargo: ext.cargo ?? cargoSecretario,
            emails: ext.emails,
            telefones: ext.telefones,
            fonte: "Site oficial da Secretaria de Educação",
            fonteUrl: topNome!.url,
            contexto: ext.contexto,
            nomeFonte: nomeFonte ?? (ext.secretario ? "snippet" : null),
            dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
            horarioAtendimento: ext.horarioAtendimento ?? null,
          });
        }
      }
    }
  }

  // ============================================================
  // ESTÁGIO 2 — CONTATO VINCULADO AO NOME (cascata interna)
  // ============================================================
  let melhorParcial: { ext: Extracted; url: string | null; via: string } | null = null;

  const tentarContato = async (
    query: string,
    via: string,
    etapaTag: EtapaTag,
    hierarquia: Hierarquia,
  ): Promise<ProspectResult | null> => {
    const cands = await gSearch(fc, query, emit, etapaTag, { limit: 8, tbs: "qdr:y", timeoutMs: 8000 });
    addToPool(cands);
    if (cands.length === 0) return null;
    const ranked = preferGov(cands, (u) => /(educa|seduc|sme)/i.test(u));
    const snippets = snippetsBlock(ranked);
    const ext = await extractWithAI(snippets, ranked[0]?.url ?? "(snippets)", hierarquia, municipio, uf, emit, {
      nomeAlvo: nomeSecretario,
      modo: "snippets",
      topHost,
    });
    if (ext && hasUsefulContact(ext)) {
      const hasGoodEmail = ext.emails.some((e) => !GENERIC_LOCAL.test(e));
      if (hasGoodEmail || ext.telefones.length > 0) {
        emit("success", etapaTag, `✨ Contato encontrado via ${via} (${Date.now() - t0}ms)`);
        return {
          status: "found",
          hierarquia,
          secretario: ext.secretario ?? nomeSecretario,
          cargo: ext.cargo ?? cargoSecretario,
          emails: ext.emails,
          telefones: ext.telefones,
          fonte: via,
          fonteUrl: ranked[0]?.url ?? null,
          contexto: ext.contexto ?? `Snippet (${via}).`,
          nomeFonte: nomeFonte ?? (nomeSecretario ? "snippet" : null),
          dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
          horarioAtendimento: ext.horarioAtendimento ?? null,
        };
      }
      if (!melhorParcial) melhorParcial = { ext, url: ranked[0]?.url ?? null, via };
    }
    return null;
  };

  if (nomeSecretario) {
    emit("info", "contato-secretario", `Estágio 2 — contato vinculado a "${nomeSecretario}"`);
    const r2a = await tentarContato(
      `"${nomeSecretario}" "secretaria de educação" ${municipio} ${uf}`,
      `Snippet vinculado ao nome (${nomeSecretario})`,
      "contato-secretario",
      "educacao",
    );
    if (r2a) return sendFinal(r2a);

    const r2b = await tentarContato(
      `"${nomeSecretario}" ${municipio} ${uf} (email OR e-mail OR telefone OR contato)`,
      `Snippet "${nomeSecretario}" + contato`,
      "contato-secretario",
      "educacao",
    );
    if (r2b) return sendFinal(r2b);

    const all = dedupeByUrl([
      ...(await gSearch(fc, `"${nomeSecretario}" secretaria educação ${municipio} ${uf}`, emit, "contato-secretario", { limit: 5, tbs: "qdr:y", timeoutMs: 8000 })),
    ]);
    addToPool(all);
    const rankedAll = preferGov(all, (u) => /(educa|seduc|sme)/i.test(u));
    const topGov = rankedAll.find((c) => /\.gov\.br/i.test(c.url));
    if (topGov) {
      emit("info", "contato-secretario", `Estágio 2.3 — scrape do site oficial (${shortHost(topGov.url)})`);
      const md = await gScrape(fc, topGov.url, emit, "contato-secretario", { hardTimeoutMs: 8000 });
      if (md) {
        const combined = `### Site\n${md}`;
        const ext = await extractWithAI(combined, topGov.url, "educacao", municipio, uf, emit, {
          nomeAlvo: nomeSecretario,
          modo: "site",
          topHost,
        });
        if (ext && hasUsefulContact(ext)) {
          const hasGood = ext.emails.some((e) => !GENERIC_LOCAL.test(e)) || ext.telefones.length > 0;
          if (hasGood) {
            emit("success", "contato-secretario", `✨ Contato via site oficial (${Date.now() - t0}ms)`);
            return sendFinal({
              status: "found",
              hierarquia: "educacao",
              secretario: ext.secretario ?? nomeSecretario,
              cargo: ext.cargo ?? cargoSecretario,
              emails: ext.emails,
              telefones: ext.telefones,
              fonte: "Site oficial (busca por nome)",
              fonteUrl: topGov.url,
              contexto: ext.contexto,
              nomeFonte,
              dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
              horarioAtendimento: ext.horarioAtendimento ?? null,
            });
          }
          if (!melhorParcial) melhorParcial = { ext, url: topGov.url, via: "Site oficial (busca por nome)" };
        }
      }
    }
  }

  // ============================================================
  // ESTÁGIO 3 — CONTATO INSTITUCIONAL DA SECRETARIA (sem o nome)
  // ============================================================
  emit("info", "educacao", "Estágio 3 — contato institucional da Secretaria de Educação");

  const r3a = await tentarContato(
    `"secretaria municipal de educação" ${municipio} ${uf} (email OR contato OR telefone)`,
    "Snippet institucional Educação",
    "educacao",
    "educacao",
  );
  if (r3a) return sendFinal(r3a);

  const r3b = await tentarContato(
    `secretaria de educação ${municipio} ${uf} site:gov.br`,
    "Snippet site:gov.br Educação",
    "educacao",
    "educacao",
  );
  if (r3b) return sendFinal(r3b);

  const all3 = dedupeByUrl([
    ...(await gSearch(fc, `secretaria municipal de educação ${municipio} ${uf} contato`, emit, "educacao", { limit: 6, timeoutMs: 8000 })),
  ]);
  addToPool(all3);
  const ranked3 = preferGov(all3, (u) => /(educa|seduc|sme)/i.test(u));
  const top3 = ranked3.find((c) => /\.gov\.br|\.leg\.br/i.test(c.url)) ?? ranked3[0];

  // Estágio 3.2 — scrape DEDICADO da página de contato do host de top3 (Correção 3).
  // Captura e-mails como "seduc@municipio.gov.br" que aparecem só em /contato.
  if (top3) {
    const top3Host = shortHost(top3.url);
    const contactQuery = `site:${top3Host} contato OR "fale conosco" OR "e-mail" secretaria educação`;
    const contactCands = await gSearch(fc, contactQuery, emit, "educacao", { limit: 3, timeoutMs: 8000 });
    addToPool(contactCands);
    const contactRe = /(\/contato|\/fale[-_]?conosco|\/fale[-_]?com[-_]?nos|\/secretarias?\/educa|\/educacao\/contato|\/atendimento)/i;
    const contactUrls = contactCands
      .filter((c) => contactRe.test(c.url))
      .map((c) => c.url)
      .slice(0, 2);
    for (const cu of contactUrls) {
      emit("info", "educacao", `Estágio 3.2 — scrape página de contato ${shortHost(cu)}`);
      const cmd = await gScrape(fc, cu, emit, "educacao", { hardTimeoutMs: 8000 });
      if (!cmd) continue;
      const cext = await extractWithAI(`### Página de Contato\n${cmd}`, cu, "educacao", municipio, uf, emit, {
        nomeAlvo: nomeSecretario,
        modo: "site",
        topHost,
      });
      if (cext && hasUsefulContact(cext)) {
        const hasGood = cext.emails.some((e) => !GENERIC_LOCAL.test(e)) || cext.telefones.length > 0;
        if (hasGood) {
          emit("success", "educacao", `✨ Contato via página de contato dedicada (${Date.now() - t0}ms)`);
          return sendFinal({
            status: "found",
            hierarquia: "educacao",
            secretario: cext.secretario ?? nomeSecretario,
            cargo: cext.cargo ?? cargoSecretario,
            emails: cext.emails,
            telefones: cext.telefones,
            fonte: "Página de contato da Secretaria",
            fonteUrl: cu,
            contexto: cext.contexto,
            nomeFonte,
            dataReferencia: cext.dataReferencia ?? dataReferenciaGlobal,
            horarioAtendimento: cext.horarioAtendimento ?? null,
          });
        }
        if (!melhorParcial) melhorParcial = { ext: cext, url: cu, via: "Página de contato da Secretaria" };
      }
    }
  }

  if (top3) {
    emit("info", "educacao", `Estágio 3.3 — scrape de ${shortHost(top3.url)}`);
    const md = await gScrape(fc, top3.url, emit, "educacao", { hardTimeoutMs: 8000 });
    if (md) {
      const ext = await extractWithAI(`### Site\n${md}`, top3.url, "educacao", municipio, uf, emit, {
        nomeAlvo: nomeSecretario,
        modo: "site",
        topHost,
      });
      if (ext && hasUsefulContact(ext)) {
        const hasGood = ext.emails.some((e) => !GENERIC_LOCAL.test(e)) || ext.telefones.length > 0;
        if (hasGood) {
          emit("success", "educacao", `✨ Contato institucional via site (${Date.now() - t0}ms)`);
          return sendFinal({
            status: "found",
            hierarquia: "educacao",
            secretario: ext.secretario ?? nomeSecretario,
            cargo: ext.cargo ?? cargoSecretario,
            emails: ext.emails,
            telefones: ext.telefones,
            fonte: fonteLabel("educacao"),
            fonteUrl: top3.url,
            contexto: ext.contexto,
            nomeFonte,
            dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
            horarioAtendimento: ext.horarioAtendimento ?? null,
          });
        }
        if (!melhorParcial) melhorParcial = { ext, url: top3.url, via: fonteLabel("educacao") };
      }
    }
  }

  // Devolve parcial bom de Educação se houver
  if (melhorParcial) {
    const { ext, url, via } = melhorParcial as { ext: Extracted; url: string | null; via: string };
    emit("warn", "educacao", `Sem e-mail específico de Educação — devolvendo parcial (${via})`);
    return sendFinal({
      status: "partial",
      hierarquia: "educacao",
      secretario: ext.secretario ?? nomeSecretario,
      cargo: ext.cargo ?? cargoSecretario,
      emails: ext.emails,
      telefones: ext.telefones,
      fonte: via,
      fonteUrl: url,
      contexto: ext.contexto,
      nomeFonte,
      dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
      horarioAtendimento: ext.horarioAtendimento ?? null,
    });
  }

  // ============================================================
  // ESTÁGIO 4 — Fallbacks institucionais (Câmara → Geral → Gabinete)
  // ============================================================
  async function runFallback(etapa: Hierarquia, query: string, label: string): Promise<ProspectResult | null> {
    emit("info", etapa, `${label} — snippet-only`);
    const cands = await gSearch(fc, query, emit, etapa, { limit: 8, timeoutMs: 5000 });
    addToPool(cands);
    const ranked = preferGov(cands);
    if (ranked.length === 0) return null;
    const snippets = snippetsBlock(ranked);
    let ext = await extractWithAI(snippets, ranked[0].url, etapa, municipio, uf, emit, { modo: "snippets", topHost });
    if (!ext || !hasUsefulContact(ext)) {
      const md = await gScrape(fc, ranked[0].url, emit, etapa, { hardTimeoutMs: 5000 });
      if (md) {
        const combined = [snippets, `### Site\n${md}`].filter(Boolean).join("\n\n");
        ext = await extractWithAI(combined, ranked[0].url, etapa, municipio, uf, emit, { modo: "site", topHost });
      }
    }
    if (!ext || !hasUsefulContact(ext)) return null;
    // Correção 4: para cidades grandes, NÃO devolver parcial com emails vazios
    // (anti-contam zerou tudo). Devolver null força o próximo fallback a tentar.
    if (ext.emails.length === 0 && LARGE_MUNI_SLUGS.has(slug)) {
      emit("warn", etapa, `Cidade grande (${slug}) + emails=[] após anti-contam — recusando parcial vazio, próximo fallback`);
      return null;
    }
    return {
      status: "partial",
      hierarquia: etapa,
      secretario: nomeSecretario ?? ext.secretario,
      cargo: cargoSecretario ?? ext.cargo,
      emails: ext.emails,
      telefones: ext.telefones,
      fonte: fonteLabel(etapa),
      fonteUrl: ranked[0].url,
      contexto: ext.contexto,
      nomeFonte: nomeSecretario ? nomeFonte : null,
      dataReferencia: ext.dataReferencia ?? dataReferenciaGlobal,
      horarioAtendimento: ext.horarioAtendimento ?? null,
    };
  }

  // 4.1 — Câmara Municipal (geralmente tem "Fale Conosco" com e-mail institucional)
  emit("warn", "fallback", "Estágio 4.1 — Câmara Municipal (contato/fale conosco)");
  const r4a = await runFallback(
    "camara",
    `câmara municipal ${municipio} ${uf} contato fale conosco (site:${slug}.${ufLow}.leg.br OR site:camara${slug}.${ufLow}.leg.br OR site:.leg.br)`,
    "Câmara Municipal",
  );
  if (r4a) return sendFinal(r4a);

  // 4.2 — Contato geral da Prefeitura
  emit("warn", "fallback", "Estágio 4.2 — contato geral da Prefeitura");
  const r4b = await runFallback(
    "geral",
    `prefeitura ${municipio} ${uf} ouvidoria contato e-mail telefone`,
    "Contato geral da Prefeitura",
  );
  if (r4b) return sendFinal(r4b);

  // 4.3 — Gabinete do Prefeito
  emit("warn", "fallback", "Estágio 4.3 — Gabinete do Prefeito");
  const r4c = await runFallback(
    "gabinete",
    `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`,
    "Gabinete do Prefeito",
  );
  if (r4c) return sendFinal(r4c);

  if (nomeSecretario) {
    emit("warn", "final", "Só consegui o nome — devolvendo parcial");
    return sendFinal({
      status: "partial",
      hierarquia: "educacao",
      secretario: nomeSecretario,
      cargo: cargoSecretario,
      emails: [],
      telefones: [],
      fonte: nomeFonte === "diario" ? "Querido Diário" : "Snippet do Google",
      fonteUrl: topNome?.url ?? null,
      contexto: "Nome identificado, mas não localizamos e-mail/telefone associados.",
      nomeFonte,
      dataReferencia: dataReferenciaGlobal,
      horarioAtendimento: null,
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
    horarioAtendimento: null,
  });
}


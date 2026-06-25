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
});

const NomeSchema = z.object({
  secretario: z.string().nullable().optional().default(null),
  cargo: z.string().nullable().optional().default(null),
  contexto: z.string().nullable().optional().default(null),
  confianca: ConfiancaLoose.default("baixa"),
});

type Extracted = {
  secretario: string | null;
  cargo: string | null;
  emails: string[];
  telefones: string[];
  contexto: string | null;
  confianca: "alta" | "media" | "baixa";
};

type NomeOnly = {
  secretario: string | null;
  cargo: string | null;
  contexto: string | null;
  confianca: "alta" | "media" | "baixa";
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

async function searchFirstUrl(
  fc: Firecrawl,
  query: string,
  prefer: (url: string) => boolean,
  emit: Emit,
  etapa: EtapaTag,
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
  const prompt = `Você é um analista que identifica autoridades municipais a partir de páginas oficiais de ${municipio}/${uf}.

OBJETIVO ÚNICO desta etapa:
  Descobrir o NOME COMPLETO do(a) Secretário(a) Municipal de Educação de ${municipio}/${uf}.
  NÃO precisa extrair contatos agora. Foco só no nome.

REGRAS:
- Só devolva um nome se ele aparecer LITERALMENTE no conteúdo abaixo, citado como responsável pela Secretaria de Educação (pode ser "Secretário(a) de Educação", "titular da Secretaria Municipal de Educação", etc.).
- "confianca" = "alta" só se o nome estiver explicitamente associado ao cargo de Secretário(a) de Educação.
- Se não houver nome, devolva secretario = null.

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

  const hints = extractContactsRegex(markdown);
  const hintsBlock =
    hints.emails.length || hints.telefones.length
      ? `\nPISTAS pré-extraídas por regex (use SOMENTE se também aparecerem no conteúdo abaixo, e descarte falsos positivos):\n  e-mails: ${hints.emails.join(", ") || "—"}\n  telefones: ${hints.telefones.join(", ") || "—"}\n`
      : "";

  const fullMd = extraMarkdown ? `${extraMarkdown}\n\n### Conteúdo do site\n${markdown}` : markdown;

  const prompt = `Você é um analista que extrai contatos institucionais de páginas oficiais da prefeitura de ${municipio}/${uf}.

ALVO PRINCIPAL DO PROJETO:
  Secretaria Municipal de Educação de ${municipio}/${uf}.
  Queremos: NOME do(a) Secretário(a) + E-MAILS e TELEFONES dela ou da Secretaria de Educação.

${nomeAlvo ? `NOME-ALVO CONFIRMADO: "${nomeAlvo}". Priorize contatos vinculados a essa pessoa.\n` : ""}
FOCO DESTA EXTRAÇÃO (etapa = "${etapa}"):
  ${focoEtapa}

REGRAS RÍGIDAS:
- NUNCA invente. Só extraia o que aparece LITERALMENTE no texto.
- "secretario" só com nome de pessoa real citada como responsável pela Educação.
- E-mails/telefones precisam aparecer literalmente no texto. Telefones brasileiros com DDD quando possível.
- "confianca" = "alta" só se o alvo desta etapa estiver claramente identificado.
- Se a página claramente não traz nada útil, devolva arrays vazios e confianca = "baixa".

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

/** Tenta extrair um nome a partir dos trechos do diário oficial sem chamar IA. */
function nomeDoDiario(excerpts: DiarioExcerpt[]): string | null {
  if (excerpts.length === 0) return null;
  const re =
    /secret[áa]ri[oa](?:\s+municipal)?\s+(?:de\s+)?educa[çc][ãa]o[^.,;:\n]{0,30}?[,:\-–]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+(?:de|da|do|dos|das|e)\s+|\s+)[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+){0,3})/i;
  for (const ex of excerpts) {
    const m = ex.trecho.match(re);
    if (m) return m[1].trim();
  }
  return null;
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
  let nomeFonte: "diario" | "site" | "busca-nome" | null = null;
  let urlSiteEducacao: string | null = null;
  let mdSiteEducacao: string | null = null;
  let extraConfirmado: Extracted | null = null; // se já veio contato no site institucional

  // A1: Querido Diário em paralelo com a busca do site
  let diarioExcerpts: DiarioExcerpt[] = [];
  let diarioPromise: Promise<void> = Promise.resolve();
  if (ibgeId) {
    emit("info", "diario", `Consultando Querido Diário (cód. IBGE ${ibgeId})...`);
    diarioPromise = (async () => {
      const r = await buscarDiario(
        ibgeId,
        '"secretário de educação" OR "secretária de educação" OR "secretario municipal de educação"',
        { size: 5, sinceDays: 730 },
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
        `Encontrei ${r.excerpts.length} trecho(s) no diário oficial`,
        { excerpts: r.excerpts.slice(0, 3) },
      );
      const cand = nomeDoDiario(r.excerpts);
      if (cand) {
        nomeSecretario = cand;
        nomeFonte = "diario";
        emit("success", "diario", `Pista forte do diário: nome provável = ${cand}`);
      }
    })();
  } else {
    emit("info", "diario", "Sem código IBGE — pulando consulta ao Querido Diário");
  }

  // A2: busca + scrape do site oficial da Educação (em paralelo lógico ao diário)
  emit("info", "nome", "Estágio A — descobrindo o nome do(a) Secretário(a) de Educação");
  const urlSite = await searchFirstUrl(
    fc,
    `prefeitura municipal ${municipio} ${uf} secretaria de educação secretário`,
    (u) => /\.gov\.br/i.test(u) && /(educa|secretari)/i.test(u),
    emit,
    "nome",
  );
  if (urlSite) {
    urlSiteEducacao = urlSite;
    mdSiteEducacao = await scrapeMarkdown(fc, urlSite, emit, "nome");
  }

  // Espera o diário terminar antes de montar prompt
  await diarioPromise;
  const diarioBlock = formatExcerptsForPrompt(diarioExcerpts);

  // A3: tenta extração COMPLETA do site (atalho feliz: já vem nome + contato)
  if (mdSiteEducacao && urlSiteEducacao) {
    const full = await extractWithAI(
      mdSiteEducacao,
      urlSiteEducacao,
      "educacao",
      municipio,
      uf,
      emit,
      nomeSecretario,
      diarioBlock || undefined,
    );
    if (full?.secretario && !nomeSecretario) {
      nomeSecretario = full.secretario;
      nomeFonte = "site";
    }
    if (full && hasUsefulContact(full) && full.secretario) {
      emit("success", "educacao", "Atalho feliz: nome + contato direto da Educação no site oficial");
      const result: ProspectResult = {
        status: "found",
        hierarquia: "educacao",
        secretario: full.secretario,
        cargo: full.cargo,
        emails: full.emails,
        telefones: full.telefones,
        fonte: fonteLabel("educacao"),
        fonteUrl: urlSiteEducacao,
        contexto: full.contexto,
        nomeFonte,
      };
      onEvent?.({ kind: "final", result, ts: Date.now() });
      return result;
    }
    if (full && hasUsefulContact(full)) {
      extraConfirmado = full; // contato sem nome — guarda como parcial
    }
  } else if (!nomeSecretario) {
    // A.alt: extrai só o nome do site se houve scrape mas sem contato útil ainda
    emit("info", "nome", "Vou tentar identificar pelo menos o nome no site da Secretaria");
  }

  // Se ainda não temos nome E temos markdown, faz extração focada em nome
  if (!nomeSecretario && mdSiteEducacao && urlSiteEducacao) {
    const n = await extractNomeWithAI(
      mdSiteEducacao,
      urlSiteEducacao,
      municipio,
      uf,
      diarioBlock,
      emit,
    );
    if (n?.secretario) {
      nomeSecretario = n.secretario;
      nomeFonte = "site";
    }
  }

  // ===== ESTÁGIO B: contatos a partir do NOME =====
  if (nomeSecretario) {
    emit(
      "info",
      "contato-secretario",
      `Estágio B — buscando contatos de "${nomeSecretario}" (${(nomeFonte as string | null) === "diario" ? "via Diário Oficial" : "via site oficial"})`,
    );
    const queries = [
      `"${nomeSecretario}" secretário educação ${municipio} ${uf} e-mail telefone`,
      `"${nomeSecretario}" secretaria municipal educação ${municipio} contato`,
    ];
    for (const q of queries) {
      const u = await searchFirstUrl(
        fc,
        q,
        (url) => /\.gov\.br/i.test(url),
        emit,
        "contato-secretario",
      );
      if (!u) continue;
      const md = await scrapeMarkdown(fc, u, emit, "contato-secretario");
      if (!md) continue;
      const ext = await extractWithAI(
        md,
        u,
        "educacao",
        municipio,
        uf,
        emit,
        nomeSecretario,
      );
      if (ext && hasUsefulContact(ext)) {
        emit("success", "contato-secretario", "Achei contato vinculado ao nome — finalizando");
        const result: ProspectResult = {
          status: "found",
          hierarquia: "educacao",
          secretario: ext.secretario ?? nomeSecretario,
          cargo: ext.cargo,
          emails: ext.emails,
          telefones: ext.telefones,
          fonte: fonteLabel("educacao"),
          fonteUrl: u,
          contexto: ext.contexto ?? `Contato encontrado em busca dirigida pelo nome ("${nomeSecretario}").`,
          nomeFonte,
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
  // Se já temos um contato institucional (sem nome) do site da Educação, registra como parcial.
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
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  emit("warn", "fallback", "Caindo para contato geral da prefeitura");
  emit("info", "geral", "Estágio D1 — procurando um contato geral da prefeitura");
  const urlGeral = await searchFirstUrl(
    fc,
    `secretaria geral prefeitura ${municipio} ${uf} contato e-mail telefone ouvidoria`,
    (u) => /\.gov\.br/i.test(u),
    emit,
    "geral",
  );
  let e2: Extracted | null = null;
  if (urlGeral) {
    const md = await scrapeMarkdown(fc, urlGeral, emit, "geral");
    if (md) e2 = await extractWithAI(md, urlGeral, "geral", municipio, uf, emit);
  }
  if (e2 && hasUsefulContact(e2)) {
    emit("success", "geral", "Achei um contato geral utilizável");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "geral",
      secretario: nomeSecretario ?? e2.secretario,
      cargo: e2.cargo,
      emails: e2.emails,
      telefones: e2.telefones,
      fonte: fonteLabel("geral"),
      fonteUrl: urlGeral,
      contexto: e2.contexto ?? "Contato geral da prefeitura (sem dados da Educação)",
      nomeFonte: nomeSecretario ? nomeFonte : null,
    };
    onEvent?.({ kind: "final", result, ts: Date.now() });
    return result;
  }

  emit("warn", "fallback", "Sem contato geral utilizável — última tentativa: gabinete do prefeito");
  emit("info", "gabinete", "Estágio D2 — procurando o gabinete do prefeito");
  const urlGab = await searchFirstUrl(
    fc,
    `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`,
    (u) => /\.gov\.br/i.test(u),
    emit,
    "gabinete",
  );
  let e3: Extracted | null = null;
  if (urlGab) {
    const md = await scrapeMarkdown(fc, urlGab, emit, "gabinete");
    if (md) e3 = await extractWithAI(md, urlGab, "gabinete", municipio, uf, emit);
  }
  if (e3 && hasUsefulContact(e3)) {
    emit("success", "gabinete", "Achei contato no gabinete do prefeito");
    const result: ProspectResult = {
      status: "partial",
      hierarquia: "gabinete",
      secretario: nomeSecretario ?? e3.secretario,
      cargo: e3.cargo,
      emails: e3.emails,
      telefones: e3.telefones,
      fonte: fonteLabel("gabinete"),
      fonteUrl: urlGab,
      contexto: e3.contexto ?? "Contato do gabinete do prefeito",
      nomeFonte: nomeSecretario ? nomeFonte : null,
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

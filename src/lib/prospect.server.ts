import Firecrawl from "@mendable/firecrawl-js";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import type { Hierarquia, ProspectResult } from "./prospect.types";

export type { Hierarquia, ProspectResult };

const ExtractSchema = z.object({
  secretario: z.string().nullable().describe("Nome completo do secretário ou responsável; null se não encontrado"),
  cargo: z.string().nullable().describe("Cargo/título exato encontrado; null se não encontrado"),
  emails: z.array(z.string()).describe("E-mails de contato encontrados"),
  telefones: z.array(z.string()).describe("Telefones de contato encontrados"),
  contexto: z.string().nullable().describe("Breve nota explicando o que foi encontrado (1 frase)"),
  confianca: z.enum(["alta", "media", "baixa"]).describe("Quão confiante você está nos dados extraídos"),
});

type Extracted = z.infer<typeof ExtractSchema>;

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

async function searchFirstUrl(
  fc: Firecrawl,
  query: string,
  prefer: (url: string) => boolean,
): Promise<string | null> {
  try {
    const res = await fc.search(query, { limit: 6 });
    // SDK v2 returns results under `web`
    const web = (res as { web?: Array<{ url: string }> }).web ?? [];
    if (web.length === 0) return null;
    const preferred = web.find((r) => prefer(r.url));
    return (preferred ?? web[0]).url ?? null;
  } catch (e) {
    console.error("firecrawl search error", e);
    return null;
  }
}

async function scrapeMarkdown(fc: Firecrawl, url: string): Promise<string | null> {
  try {
    const res = await fc.scrape(url, {
      formats: ["markdown"],
      onlyMainContent: true,
    });
    const md =
      (res as { markdown?: string }).markdown ??
      (res as { data?: { markdown?: string } }).data?.markdown ??
      null;
    return md && md.length > 50 ? md.slice(0, 18000) : md;
  } catch (e) {
    console.error("firecrawl scrape error", e);
    return null;
  }
}

async function extractWithAI(
  markdown: string,
  url: string,
  etapa: "educacao" | "geral" | "gabinete",
  municipio: string,
  uf: string,
): Promise<Extracted | null> {
  const provider = getProvider();
  const focoMap = {
    educacao: "Secretário(a) Municipal de Educação (e a Secretaria de Educação)",
    geral: "Secretaria Geral / Administração / contato institucional da prefeitura",
    gabinete: "Gabinete do Prefeito (chefe de gabinete, prefeito, contato direto)",
  };
  const prompt = `Você está extraindo contatos institucionais a partir do conteúdo de uma página web da prefeitura de ${municipio}/${uf}.

URL: ${url}
Foco da extração: ${focoMap[etapa]}.

Regras:
- Extraia APENAS dados explicitamente presentes no texto.
- E-mails e telefones devem aparecer literalmente no conteúdo.
- Se não houver dados confiáveis sobre o foco, deixe os campos vazios e marque confianca = "baixa".
- "secretario" só deve ser preenchido com o nome de uma pessoa real mencionada como responsável.
- Telefones em formato brasileiro (com DDD se houver).

Conteúdo:
"""
${markdown}
"""`;
  try {
    const { experimental_output } = await generateText({
      model: provider("google/gemini-3-flash-preview"),
      experimental_output: Output.object({ schema: ExtractSchema }),
      prompt,
    });
    return experimental_output as Extracted;
  } catch (e) {
    console.error("ai extract error", e);
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
      ? "Secretaria Geral / Multifuncional"
      : "Gabinete do Prefeito";
}

async function runEtapa(
  fc: Firecrawl,
  query: string,
  prefer: (u: string) => boolean,
  etapa: Hierarquia,
  municipio: string,
  uf: string,
): Promise<{ extracted: Extracted; url: string } | null> {
  const url = await searchFirstUrl(fc, query, prefer);
  if (!url) return null;
  const md = await scrapeMarkdown(fc, url);
  if (!md) return null;
  const extracted = await extractWithAI(md, url, etapa, municipio, uf);
  if (!extracted) return null;
  return { extracted, url };
}

export async function prospectar(
  municipio: string,
  uf: string,
): Promise<ProspectResult> {
  const fc = getFirecrawl();

  // Etapa 1: Secretaria de Educação
  const e1 = await runEtapa(
    fc,
    `prefeitura municipal ${municipio} ${uf} secretaria de educação contato secretário`,
    (u) => /\.gov\.br/i.test(u) && /(educa|secretari)/i.test(u),
    "educacao",
    municipio,
    uf,
  );
  if (e1 && hasUsefulContact(e1.extracted)) {
    return {
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
  }

  // Etapa 2: Secretaria Geral
  const e2 = await runEtapa(
    fc,
    `secretaria geral prefeitura ${municipio} ${uf} contato e-mail telefone`,
    (u) => /\.gov\.br/i.test(u),
    "geral",
    municipio,
    uf,
  );
  if (e2 && hasUsefulContact(e2.extracted)) {
    return {
      status: "partial",
      hierarquia: "geral",
      secretario: e2.extracted.secretario,
      cargo: e2.extracted.cargo,
      emails: e2.extracted.emails,
      telefones: e2.extracted.telefones,
      fonte: fonteLabel("geral"),
      fonteUrl: e2.url,
      contexto:
        e2.extracted.contexto ?? "Secretaria geral — atende múltiplas pastas",
    };
  }

  // Etapa 3: Gabinete
  const e3 = await runEtapa(
    fc,
    `gabinete do prefeito ${municipio} ${uf} contato e-mail telefone`,
    (u) => /\.gov\.br/i.test(u),
    "gabinete",
    municipio,
    uf,
  );
  if (e3 && hasUsefulContact(e3.extracted)) {
    return {
      status: "partial",
      hierarquia: "gabinete",
      secretario: e3.extracted.secretario,
      cargo: e3.extracted.cargo,
      emails: e3.extracted.emails,
      telefones: e3.extracted.telefones,
      fonte: fonteLabel("gabinete"),
      fonteUrl: e3.url,
      contexto:
        e3.extracted.contexto ?? "Contato direto com o gabinete do prefeito",
    };
  }

  // Fallback: retorne o melhor parcial que tivermos
  const best = [e1, e2, e3].find((x) => x && (x.extracted.emails.length || x.extracted.telefones.length));
  if (best) {
    const h: Hierarquia = best === e1 ? "educacao" : best === e2 ? "geral" : "gabinete";
    return {
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
  }

  return {
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
}

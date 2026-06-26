// Scraper próprio rodando no Worker — fetch nativo + parser HTML em regex.
// Usado como primeira tentativa antes do Firecrawl em prospect.server.ts.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

export type FetchEmit = (msg: string, data?: unknown) => void;

export type FetchResult =
  | { ok: true; html: string; finalUrl: string; bytes: number }
  | { ok: false; reason: string };

export async function fetchHtml(
  url: string,
  opts: { timeoutMs?: number; emit?: FetchEmit } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, reason: `redirect ${res.status} sem location` };
        currentUrl = new URL(loc, currentUrl).toString();
        opts.emit?.(`Redirecionado para ${currentUrl}`);
        continue;
      }

      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ct && !ct.includes("html") && !ct.includes("xml") && !ct.includes("text/plain")) {
        return { ok: false, reason: `content-type não-HTML (${ct})` };
      }

      // Lê limitado a MAX_BYTES
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        return { ok: true, html: text, finalUrl: currentUrl, bytes: text.length };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
          if (total >= MAX_BYTES) {
            try {
              await reader.cancel();
            } catch {
              /* noop */
            }
            break;
          }
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const html = new TextDecoder("utf-8", { fatal: false }).decode(merged);
      return { ok: true, html, finalUrl: currentUrl, bytes: total };
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      return { ok: false, reason: aborted ? `timeout ${timeoutMs}ms` : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "muitos redirects" };
}

// ---------- HTML → Markdown leve ----------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  atilde: "ã",
  otilde: "õ",
  ccedil: "ç",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Atilde: "Ã",
  Otilde: "Õ",
  Ccedil: "Ç",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

export function htmlToMarkdown(html: string, pageUrl?: string): string {
  let s = html;

  // Header opcional: title + description
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const descMatch = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(s);
  const headerParts: string[] = [];
  if (titleMatch) headerParts.push(`# ${decodeEntities(titleMatch[1]).trim()}`);
  if (descMatch) headerParts.push(`> ${decodeEntities(descMatch[1]).trim()}`);

  // Remove blocos não-conteúdo
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, "");

  let pageHost: string | null = null;
  if (pageUrl) {
    try {
      pageHost = new URL(pageUrl).host.toLowerCase();
    } catch {
      pageHost = null;
    }
  }

  // Links: <a href="X">txt</a>  → [txt](X) — mas omite href quando aponta para
  // outro domínio ou é mailto:, para não contaminar o texto com e-mails/URLs
  // de outras cidades que enganariam a verificação "literal no source".
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, txt: string) => {
      const cleanTxt = txt
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const hrefLow = href.trim().toLowerCase();
      // mailto / tel — nunca exibe o destino como texto
      if (hrefLow.startsWith("mailto:") || hrefLow.startsWith("tel:")) {
        return ` ${cleanTxt} `;
      }
      // links externos absolutos: só mostra o texto se houver, senão ignora
      if (/^https?:\/\//i.test(href)) {
        if (pageHost) {
          try {
            const linkHost = new URL(href).host.toLowerCase();
            if (linkHost !== pageHost && !linkHost.endsWith(`.${pageHost}`) && !pageHost.endsWith(`.${linkHost}`)) {
              return ` ${cleanTxt} `;
            }
          } catch {
            return ` ${cleanTxt} `;
          }
        }
        return ` [${cleanTxt || href}](${href}) `;
      }
      // links relativos: só o texto (sem href)
      return ` ${cleanTxt} `;
    },
  );


  // Quebras de bloco
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|tr|h[1-6])\s*>/gi, "\n\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li\s*>/gi, "");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(parseInt(n, 10))} `);
  s = s.replace(/<td[^>]*>/gi, " | ");

  // Strip todas as tags restantes
  s = s.replace(/<[^>]+>/g, " ");

  // Decode entidades e normaliza whitespace
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  const final = [headerParts.join("\n"), s].filter(Boolean).join("\n\n");
  return final.slice(0, 25_000);
}

// ---------- Regex de contatos ----------

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BAD_EMAIL_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)$/i;

// Captura número BR (com ou sem DDD entre parênteses). Validamos depois.
const PHONE_RE = /\(?(\d{2})\)?[\s.-]?9?\d{4}[-.\s]?\d{4}/g;
const PHONE_CONTEXT_RE = /(tel|fone|telefone|fax|whats\s?app|whats|zap|cel|celular|contato|telephone)/i;

const VALID_DDDS = new Set<number>([
  11,12,13,14,15,16,17,18,19,
  21,22,24,27,28,
  31,32,33,34,35,37,38,
  41,42,43,44,45,46,47,48,49,
  51,53,54,55,
  61,62,63,64,65,66,67,68,69,
  71,73,74,75,77,79,
  81,82,83,84,85,86,87,88,89,
  91,92,93,94,95,96,97,98,99,
]);

function formatBrPhone(raw: string): string | null {
  const d = raw.replace(/\D+/g, "");
  // Considera apenas formatos plausíveis: DDD + 8 (fixo) ou DDD + 9 (celular)
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = parseInt(d.slice(0, 2), 10);
  if (!VALID_DDDS.has(ddd)) return null;
  if (d.length === 11) {
    // celular precisa começar com 9 no terceiro dígito
    if (d[2] !== "9") return null;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}

export function extractContactsRegex(text: string): { emails: string[]; telefones: string[] } {
  const emailsRaw = text.match(EMAIL_RE) ?? [];
  const emails = Array.from(
    new Set(emailsRaw.map((e) => e.trim()).filter((e) => !BAD_EMAIL_EXT.test(e))),
  ).slice(0, 25);

  const phones: string[] = [];
  const seen = new Set<string>();
  PHONE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const match = m[0];
    const idx = m.index;
    // Janela de contexto: 60 chars antes/depois
    const winStart = Math.max(0, idx - 60);
    const winEnd = Math.min(text.length, idx + match.length + 60);
    const window = text.slice(winStart, winEnd);
    // Aceita se houver palavra-chave de telefone, OU se o próprio match tiver
    // parênteses no DDD ou hífen no separador (ex.: "(44) 3221-1234").
    const hasKeyword = PHONE_CONTEXT_RE.test(window);
    const hasFormatHint = /\(\s*\d{2}\s*\)/.test(match) || /\d{4,5}-\d{4}/.test(match);
    if (!hasKeyword && !hasFormatHint) continue;
    const formatted = formatBrPhone(match);
    if (!formatted) continue;
    if (seen.has(formatted)) continue;
    seen.add(formatted);
    phones.push(formatted);
    if (phones.length >= 25) break;
  }

  return { emails, telefones: phones };
}


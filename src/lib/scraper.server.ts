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
  const timeoutMs = opts.timeoutMs ?? 12_000;
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

export function htmlToMarkdown(html: string): string {
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

  // Links: <a href="X">txt</a>  → [txt](X)
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, txt: string) => {
      const cleanTxt = txt
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return ` [${cleanTxt || href}](${href}) `;
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
const PHONE_RE = /\(?\b\d{2}\)?\s?9?\d{4}[-.\s]?\d{4}\b/g;

export function extractContactsRegex(text: string): { emails: string[]; telefones: string[] } {
  const emailsRaw = text.match(EMAIL_RE) ?? [];
  const emails = Array.from(
    new Set(emailsRaw.map((e) => e.trim()).filter((e) => !BAD_EMAIL_EXT.test(e))),
  ).slice(0, 25);

  const phonesRaw = text.match(PHONE_RE) ?? [];
  const telefones = Array.from(new Set(phonesRaw.map((p) => p.trim()))).slice(0, 25);

  return { emails, telefones };
}

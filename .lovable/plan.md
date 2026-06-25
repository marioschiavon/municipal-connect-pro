## Objetivo
1. Reduzir custo/dependência do Firecrawl no scrape, mantendo-o só para a busca e como rede de segurança quando o fetch nativo falhar.
2. Introduzir versionamento automático visível no badge do cabeçalho.

---

## Parte 1 — Scraper próprio

### 1.1 Novo módulo `src/lib/scraper.server.ts`
Scraper rodando no Worker (fetch nativo + parsing puro, sem deps novas):

- `fetchHtml(url, { timeoutMs, emit })`: `fetch` com `AbortController` (timeout 12s), `User-Agent` de navegador, `Accept-Language: pt-BR`, segue até 5 redirects manualmente, valida `content-type` text/html, lê no máx. ~1.5MB.
- `htmlToMarkdown(html)`: pipeline em regex —
  - remove `<script>`, `<style>`, `<noscript>`, comentários
  - extrai `<title>` e `<meta name="description">` num header
  - converte `<a href>` → `[texto](href)` (preserva mailto/tel)
  - converte `<br>`, `<p>`, `<li>`, `<h1-6>` em quebras/marcadores
  - decodifica entidades HTML
  - colapsa whitespace, limita a ~25k chars
- `extractContactsRegex(text)`: extra — captura e-mails e telefones BR, devolve listas únicas pra IA cruzar.

Compatível com Workers — sem `cheerio`/`jsdom`.

### 1.2 Atualizar `src/lib/prospect.server.ts`
Em `scrapeMarkdown(fc, url, emit, etapa)`:
1. Emite `scrape_start`.
2. Tenta `fetchHtml` + `htmlToMarkdown`.
   - Sucesso (markdown ≥ 200 chars úteis): emite `scrape_done { via: "native", bytes }` e retorna.
   - Falha (timeout, status≠2xx, content-type errado, markdown vazio, exceção): emite `scrape_fallback { reason }` e cai pro Firecrawl atual.
3. `searchFirstUrl` (Firecrawl `search`) permanece intacto.

Pistas do regex anexadas ao prompt da IA pra reduzir alucinação; schema de saída inalterado.

### 1.3 UI/Debug
- `ResultCard` timeline: "Baixando página direto…", "Página baixada (12 KB)", "Bloqueado, usando Firecrawl…".
- `/debug` recebe os eventos via `logDebug` automaticamente.
- Sem mudança em `ProspectResult` nem na exportação.

---

## Parte 2 — Versionamento automático

### 2.1 Novo arquivo `src/lib/version.ts`
```ts
export const APP_VERSION = "Alpha v0.2";
```
Fonte única usada pelo header e pelo `/debug`. **Regra fixa: nunca bumpar para `v1.0` sem autorização explícita do usuário.** Comentário no topo do arquivo deixa isso explícito.

### 2.2 Política de bump
A cada turno que envolver alteração funcional de código (não conta correção de typo/comentário), o agente incrementa o patch:
- `Alpha v0.1` → `Alpha v0.2` → `Alpha v0.3` → … `Alpha v0.9` → `Alpha v0.10` → `Alpha v0.11` …
- Permanece `Alpha` indefinidamente.
- Transição para `v1.0` (ou Beta) **só sob comando explícito** do usuário.

Esta entrega já bumpa para **`Alpha v0.2`** (scraper próprio).

### 2.3 Consumo
- `src/routes/index.tsx`: badge no header passa a importar `APP_VERSION` em vez de string literal.
- `src/routes/debug.tsx`: mostra a versão atual no topo da tela de debug.

### 2.4 Memória
Salvar em `mem://constraints/versioning.md` a regra "nunca subir para v1.0 sem autorização" + a regra de bump por turno funcional, e referenciar no `mem://index.md` (Core).

---

## Arquivos
- **novo**: `src/lib/scraper.server.ts`
- **novo**: `src/lib/version.ts`
- **novo**: `mem://constraints/versioning.md` + update `mem://index.md`
- **edit**: `src/lib/prospect.server.ts` (só `scrapeMarkdown` + emits)
- **edit**: `src/components/ResultCard.tsx` (rótulos dos novos eventos)
- **edit**: `src/routes/index.tsx` (importa `APP_VERSION`)
- **edit**: `src/routes/debug.tsx` (mostra `APP_VERSION`)

## Riscos
- Sites `.gov.br` com Cloudflare/anti-bot retornam 403 → cai pro Firecrawl (esperado).
- HTML→Markdown por regex perde tabelas complexas; aceitável pro alvo (e-mails/telefones).
- SPAs sem conteúdo no HTML inicial → markdown vazio → fallback Firecrawl.

## Problema

No teste do Maringá, o Firecrawl `search()` retornou 6 resultados — mas nós só usamos a `url` do primeiro e descartamos os campos `title` e `description` (os snippets do Google). Quando a página alvo falha no scrape (foi o caso: `ERR_TUNNEL_CONNECTION_FAILED` no Firecrawl + `fetch failed` no nativo), a pipeline fica sem matéria-prima e cai direto pro fallback institucional — mesmo quando a resposta já estava visível na própria SERP.

Outro ponto: o Firecrawl `search()` aceita `scrapeOptions: { formats: ['markdown'] }` e devolve o **markdown de vários resultados de uma vez**. Hoje fazemos N requisições sequenciais (search → scrape um → scrape outro). Isso é caro e frágil.

## Plano (Alpha v0.6 → Alpha v0.7)

### 1. Aproveitar os snippets do Google como fonte de extração

`src/lib/prospect.server.ts`

- Refatorar `searchFirstUrl` em `searchCandidates` que devolve a **lista completa** dos resultados (`url`, `title`, `description`), não só uma URL.
- Concatenar `title + description` de TODOS os candidatos em um bloco "Resultados do Google" e mandar pra IA como fonte adicional — antes mesmo de scrapear qualquer página.
- Se os snippets já contêm nome + e-mail/telefone com confiança alta, encerra a etapa sem precisar baixar página nenhuma.

### 2. Search com scrape em batch (uma chamada só)

- Trocar `fc.search(q, { limit: 6 })` por `fc.search(q, { limit: 5, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } })`.
- Isso traz o markdown dos top-N resultados de uma vez, sem novas idas e voltas. Resolve o caso "site oficial caiu mas tem outro .gov.br/portal com o mesmo conteúdo".
- O bloco enviado pra IA passa a ser: snippets + markdown agregado dos candidatos (truncado por candidato pra caber no contexto).

### 3. Tentar múltiplos candidatos, não só o primeiro

- Hoje pegamos `preferred ?? web[0]` e paramos. Vamos iterar pelos top 3 .gov.br/portais, juntar o markdown que conseguirmos, e só desistir se TODOS falharem.
- Pula candidatos do Instagram/Facebook (já que o regex não acha contato útil lá).

### 4. Fallback final: extrair só dos snippets

- Se TODOS os scrapes falharem, ainda assim chama a IA com APENAS os snippets do Google. Marca o resultado como `partial` com `contexto: "Dados extraídos do resumo do Google (página não acessível)"`.
- É exatamente o que aconteceria no Maringá: snippet do `maringa.pr.gov.br/secretarias/secretaria-de-educacao/2` provavelmente já traz nome e telefone.

### 5. UI: pequeno indicador da origem

`src/components/ResultCard.tsx`

- Quando `nomeFonte === "snippet"` ou contexto contém "resumo do Google", mostrar badge `via snippet do Google` (mesma cor neutra do badge "via Diário Oficial" que já existe).

### 6. Versão

`src/lib/version.ts`: `Alpha v0.6` → `Alpha v0.7`.

## Detalhes técnicos

- A SDK do Firecrawl tipa `search()` retornando `{ web: Array<{ url, title?, description?, markdown? }> }`. Acessamos `markdown` quando passamos `scrapeOptions`.
- Limite de contexto: cortar cada `markdown` de candidato em ~6k chars; snippets ficam inteiros (são curtos).
- Manter o cache local da v0.6 — ele já evita refazer essa busca toda quando o resultado é bom.
- Manter o fluxo escalonado A→B→C→D; a mudança é só DENTRO de cada estágio (como a etapa consome os resultados do Firecrawl).
- Telemetria: novo evento `info` "Snippets do Google: N candidatos com texto útil" + log dos primeiros 200 chars de cada snippet em `/debug`.

## Não vou mexer

- Querido Diário (o 403 do Maringá é intermitente — já tem retry + User-Agent na v0.5).
- Cache local (segue como está).
- Schema da IA (`ExtractSchema`/`NomeSchema`) — só muda o conteúdo do prompt.

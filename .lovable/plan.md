# Plano — Alpha v0.11: Google-first, menos malabarismo

## Diagnóstico
Hoje cada município dispara: **3 buscas paralelas com `scrapeOptions` (Firecrawl renderiza markdown de até 5 páginas cada)** + scrape do top + Querido Diário + IA de nome + IA de extração + (estágio B) mais 2 buscas. Cada `search+scrapeOptions` custa caro e demora segundos. E o Querido Diário trava por até 6s mesmo com timeout. Ironicamente, no Google a resposta já aparece no 1º snippet — estamos "escondendo" essa resposta debaixo de scraping pesado.

## Princípio novo
**Snippet primeiro, scrape só se precisar. Diário só se sobrar tempo.**

## Mudanças propostas

### 1. Estágio A enxuto (1 busca, sem scrape)
- Substituir as 3 buscas paralelas por **uma única** `fc.search` **sem `scrapeOptions`** (só títulos/descrições, ~1 chamada barata, sub-segundo).
- Query: `secretário(a) de educação ${municipio} ${uf} ${anoAtual}` com `tbs: "qdr:y"`, `limit: 10`.
- Mandar os 10 snippets direto pra IA pedindo: **nome + e-mail + telefone + dataReferencia** numa só chamada (`extractWithAI` em modo `onlySnippets`).
- Se IA devolver nome **e** (email ou telefone) com confiança ≥ média → **finaliza aqui**. Esse é o caminho feliz do Maringá.

### 2. Estágio B só quando faltar contato
- Se veio só o nome, aí sim faz **uma** busca dirigida `"${nome}" secretaria educação ${municipio} email` (sem scrape) e roda IA nos snippets.
- Se ainda faltar, **uma** tentativa de scrape do top resultado `.gov.br` da busca A (com `scrapeMarkdown`).

### 3. Querido Diário em background, não-bloqueante
- Disparar `buscarDiario` em `Promise.race` com timeout de **2s** (não 6s) e **sem bloquear** o estágio A.
- Só usar o resultado se chegar antes da IA do estágio A terminar. Caso contrário, ignora silenciosamente.
- Adicionar toggle de UI "Consultar Diário Oficial (mais lento)" — desligado por padrão.

### 4. Fallbacks geral/gabinete também sem `scrapeOptions`
- `runFallback` passa a usar `searchCandidates(..., withScrape=false)`. Só scrapea o top 1 sob demanda se IA-de-snippet não der contato.

### 5. Telemetria de tempo por estágio
- Cada `emit` ganha `elapsedMs` desde o início; debug page mostra tempo gasto por etapa pra confirmar o ganho.

### 6. Versão
- `src/lib/version.ts` → **Alpha v0.11**.

## Arquivos afetados
- `src/lib/prospect.server.ts` — reescrita do `prospectar` seguindo o pipeline acima; `searchCandidates` ganha modo "snippet-only" como padrão.
- `src/lib/querido-diario.server.ts` — timeout interno cai pra 2s; export de função "fire-and-forget".
- `src/routes/index.tsx` — checkbox "Consultar Diário Oficial".
- `src/lib/version.ts`.

## Resultado esperado
- Caso feliz (Maringá e maioria das capitais): **1 search + 1 IA ≈ 2–4s** total, vs ~15–25s hoje.
- Custo Firecrawl cai drasticamente (sem `scrapeOptions` na maioria dos municípios).
- Diário deixa de ser gargalo.

Confirma que sigo por aí? Posso também: (a) manter as 3 buscas mas só do tipo snippet (mais robusto, ainda rápido), ou (b) deixar Diário ligado por padrão mas com timeout de 2s. Me diga se prefere alguma variação antes de eu implementar.

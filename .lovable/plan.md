## Problema
O Querido Diário pode retornar trechos antigos (até 24 meses) e a IA fica com o nome desatualizado (ex.: Maringá hoje é "Adriana"). Precisamos privilegiar o nome **atual** do(a) Secretário(a) de Educação e marcar a data da evidência.

## Bump de versão
- `src/lib/version.ts` → **Alpha v0.10**.

## Mudanças

### 1. Querido Diário — só pista recente (`src/lib/querido-diario.server.ts`)
- Reduzir janela padrão `sinceDays` de 730 → **180 dias** (últimos 6 meses).
- Ordenar por `sort_by=descending_date` (em vez de `relevance`) para pegar publicações novas primeiro.
- Manter `date` em cada `DiarioExcerpt` (já existe) e expor flag `isRecent` (≤ 120 dias).
- Em `formatExcerptsForPrompt`: deixar a data **destacada** ("📅 2026-04-10") e ordenar do mais novo pro mais antigo; adicionar nota: "Use apenas o trecho MAIS RECENTE como fonte do nome; descarte trechos antigos se forem contraditórios."

### 2. Extração de nome do diário (`prospect.server.ts > nomeDoDiario`)
- Iterar excerpts já ordenados por data desc.
- Se o trecho mais antigo trouxer nome X e um mais novo trouxer nome Y diferente, ficar com **Y** e logar: "Atualizei nome via diário mais recente (DD/MM/AAAA)".
- Só adotar `nomeFonte = "diario"` se a data do trecho for ≤ 365 dias; caso contrário, tratar como pista fraca e ainda exigir confirmação por busca.

### 3. Buscas Google focadas em atualidade (`prospect.server.ts`)
- Estágio A query atual:
  `prefeitura municipal {municipio} {uf} secretaria de educação secretário nome contato`
  → trocar por consultas que forçam recência (Firecrawl `search` aceita `tbs`):
  - Query 1: `"secretário de educação" {municipio} {uf} {anoAtual}` com `tbs: "qdr:y"` (último ano).
  - Query 2: `secretaria municipal educação {municipio} {uf} "atual" OR "nomeado" OR "empossado"` com `tbs: "qdr:y"`.
  - Query 3 (fallback amplo, sem filtro): a atual.
- Concatenar candidatos das três e deduplicar por URL antes de rankear.
- No estágio B (busca pelo nome): adicionar `tbs: "qdr:y"` também.

### 4. Prompts da IA — desempate por recência (`extractNomeWithAI` e `extractWithAI`)
- Adicionar bloco "REGRAS DE ATUALIDADE":
  - "Se houver mais de um nome citado como Secretário(a) de Educação, escolha o mais recentemente empossado (palavras-chave: nomeado, empossado, posse, decreto nº ..., data mais recente)."
  - "Snippets do Google geralmente refletem o(a) titular atual — prefira-os ao Diário Oficial quando houver conflito, a menos que o diário seja claramente mais recente."
  - "Se houver indicação de exoneração, posse, decreto ou troca, registre em `contexto` a data citada."
- Adicionar campo opcional `dataReferencia: string | null` no `ExtractSchema`/`NomeSchema` para a IA devolver a data da fonte (ex.: "2025-11", "abril/2025"). Propagar para `ProspectResult` como `dataReferencia` e exibir no `ResultCard` como badge ("atualizado em ...").

### 5. UI (`src/components/ResultCard.tsx`)
- Mostrar badge "atualizado em {dataReferencia}" ao lado do nome quando presente.
- Manter badge existente "via Diário Oficial / snippet / site".

### 6. Telemetria/debug
- Logar no `debug-log` cada vez que houver conflito de nomes entre diário e snippet (`emit("warn","nome","Conflito nome: diário=X / snippet=Y — adotando Y por ser mais recente")`).

## Fora de escopo
- Não mexer no scraper nativo nem no cache (cache continua por município/dia).
- Não criar tabela de "histórico de secretários".

## Diagrama do fluxo de desempate
```text
Diário (≤180d, sort=desc) ──┐
                            ├─► merge + flag "data"
Google (tbs=qdr:y, "atual")─┘
                            │
                            ▼
                IA com regra: prefira a evidência mais recente
                            │
                            ▼
              ProspectResult { secretario, dataReferencia }
```

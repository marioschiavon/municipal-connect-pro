## Objetivo

Trocar a estratégia atual de "um único scrape resolve tudo" por uma **busca escalonada em estágios**: primeiro descobrir o **nome** do(a) Secretário(a) de Educação; com o nome em mãos, fazer **novas buscas direcionadas** atrás dos contatos pessoais/institucionais; e só depois cair para os fallbacks (geral → gabinete). Também corrigir o erro 403 do Querido Diário.

## Novo fluxo (escalonado)

```text
Estágio A — DESCOBRIR NOME
  A1. Querido Diário (com User-Agent correto + tratamento de 403)
  A2. Google: "secretário de educação <Município> <UF>" → 1º scrape
       └─ IA extrai SÓ o nome (sem exigir contato ainda)
  A3. Se já vieram contatos úteis: pula tudo, retorna como hoje (atalho feliz)

Estágio B — CONTATOS DO SECRETÁRIO (só se temos nome)
  B1. Google: "<Nome> secretário educação <Município> e-mail telefone"
  B2. Google: "<Nome> secretaria municipal educação <Município> contato"
  → scrape do melhor resultado, IA extrai e-mail/telefone vinculados ao nome
  Para no primeiro que devolver contato útil.

Estágio C — CONTATO INSTITUCIONAL DA SECRETARIA (sem precisar de nome)
  C1. Site oficial da Secretaria de Educação no portal .gov.br
       (mantém a busca atual de hoje)

Estágio D — FALLBACK GERAL
  D1. Contato geral da prefeitura (igual hoje)
  D2. Gabinete do prefeito (igual hoje)
```

A primeira etapa que devolver `nome + (email OU telefone)` encerra a busca. Se só conseguir nome, registra como `partial` com a fonte usada.

## Mudanças por arquivo

**`src/lib/querido-diario.server.ts`**
- Adicionar `User-Agent` ("MunicipIA/0.5 (+contato)") e `Accept-Language: pt-BR` no fetch (API bloqueia clientes sem UA → causa do HTTP 403).
- Em 403/429, fazer 1 retry com backoff de 1.5s antes de desistir.
- Manter retorno `{ok:false, reason}` para que o resto do fluxo siga normalmente.

**`src/lib/prospect.server.ts`** (refator do orquestrador)
- Separar `extractWithAI` em dois modos:
  - `mode: "nome"` — schema reduzido `{ secretario, cargo, confianca }`, prompt focado só em identificar a pessoa.
  - `mode: "contato"` — schema completo, prompt instruído a vincular contatos a um **nome alvo** passado por parâmetro.
- Nova função `descobrirNome(municipio, uf, diarioExcerpts, emit)`:
  - Roda Querido Diário (já temos) + busca Google leve + 1 scrape.
  - Retorna `{ nome, fonte: "diario"|"site", url? } | null`.
- Nova função `buscarContatosDoSecretario(nome, municipio, uf, emit)`:
  - Executa as 2 queries do Estágio B em sequência, parando no primeiro resultado útil.
- Reescrever `prospectar()` para orquestrar A → B → C → D, agregando o melhor resultado parcial ao final.
- `ProspectResult.nomeFonte` passa a refletir corretamente a origem real (`"diario" | "site" | "busca-nome"`).

**`src/lib/prospect.types.ts`**
- Adicionar etapas novas ao `ProgressEvent.etapa`: `"nome"` e `"contato-secretario"` (mantém as antigas).
- Expandir `nomeFonte` com `"busca-nome"`.

**`src/routes/index.tsx`** (sidebar "Como o robô procura")
- Atualizar o texto explicativo para refletir o novo fluxo escalonado em 4 estágios (A/B/C/D em linguagem simples).

**`src/components/ResultCard.tsx`**
- Mapear ícones/labels das novas etapas (`nome`, `contato-secretario`) para a timeline ao vivo.

**`src/lib/version.ts`**
- Bump para **Alpha v0.5** (mudança funcional relevante; sem subir para v1.0).

## Resposta sobre o erro do Querido Diário

O `HTTP 403` veio porque a API pública do Querido Diário rejeita requisições sem `User-Agent` identificável (política anti-scraping padrão deles). Não é a chave que faltou — a API é aberta. A correção é adicionar o header `User-Agent` e `Accept-Language`, com um retry curto para o caso de rate-limit transitório. Se mesmo assim falhar, o fluxo segue sem o diário (já é tratado como opcional).

## Fora de escopo

- Não vamos tocar no scraper nativo nem na lógica de fallback Firecrawl (estável agora).
- Sem mudança de banco de dados / sem novas dependências.
- Sem migrar para v1.0.

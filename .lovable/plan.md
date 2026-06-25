
## Objetivo

1. Mostrar **em tempo real**, dentro de cada card de município, uma "trilha" de mensagens curtas em primeira pessoa do que o bot está fazendo ("Buscando site da prefeitura...", "Encontrei pmexemplo.sp.gov.br", "Lendo a página da Secretaria de Educação...", "Achei o nome do secretário: Fulano", "Só encontrei e-mail, sem telefone — caindo pro fallback", etc.).
2. Espelhar **tudo isso** na tela `/debug` (não só logs do IBGE) — fetch do Firecrawl, URL escolhida, tamanho do markdown, retorno da IA, decisão de fallback, erros.
3. Reforçar nas instruções da IA e na lógica de servidor o **alvo + ordem de fallback**:
   - **Alvo**: Secretaria Municipal de Educação — nome do(a) secretário(a) + e-mails/telefones dela.
   - **Fallback 1**: e-mail/telefone institucional geral da prefeitura (ouvidoria, fale conosco, secretaria geral).
   - **Fallback 2**: contato do gabinete do prefeito (ou do próprio prefeito).
   - Nunca inventar dados; só extrair o que aparece literalmente.

## Mudanças

### 1. Endpoint de streaming (servidor)

Trocar `prospectarMunicipio` (server function) por uma **server route** em `src/routes/api/prospect.ts` que devolve um stream NDJSON (`application/x-ndjson`).

- Mantém o `prospect.server.ts`, mas refatora `prospectar(municipio, uf)` para receber um `onEvent(evt)` callback e emitir eventos em pontos-chave:
  - `stage_start` (etapa: educacao/geral/gabinete) com mensagem amigável
  - `search_query` (query enviada ao Firecrawl)
  - `search_result` (URL escolhida + nº de candidatos)
  - `scrape_start` / `scrape_done` (tamanho do markdown)
  - `ai_start` / `ai_done` (resumo: secretario, nº de emails/telefones, confiança)
  - `stage_decision` ("contato útil encontrado, parando" vs. "insuficiente, indo para fallback X")
  - `final` (resultado completo)
  - `error` (mensagem)
- A rota encadeia os eventos para o client e termina com o `ProspectResult` final.

### 2. Cliente consumindo o stream

`src/routes/index.tsx`: substituir `useServerFn(prospectarMunicipio)` por um `fetch('/api/prospect', { body: JSON.stringify({ municipio, uf }) })` que lê o `ReadableStream`, parseia linha-a-linha e:

- empilha cada evento em `card.events: ProgressEvent[]` (novo campo em `RunningCard`);
- ao receber `final`, troca o card pra `phase: 'done'`;
- também chama `logDebug(...)` pra cada evento, com `scope` igual a `prospect:<municipio>` — assim a tela `/debug` mostra o fluxo completo.

### 3. `ResultCard` com timeline ao vivo

Adicionar, abaixo do header do card e enquanto `phase !== 'done'`, uma lista vertical compacta dos últimos ~6 eventos:
- ícone por tipo (lupa, globo, cérebro, check, alerta)
- texto curto em português (vem do servidor)
- timestamp relativo ("agora", "2s atrás")
- quando vira `done`, a timeline some (ou colapsa atrás de um `<details>Ver passos</details>`).

### 4. Regras de extração reforçadas (`prospect.server.ts`)

Reescrever o prompt da IA pra deixar claro:

```
ALVO PRINCIPAL: Secretaria Municipal de Educação de {municipio}/{uf}.
  Queremos: nome do(a) Secretário(a) de Educação + e-mails e telefones DELA / DA SECRETARIA.

Se o conteúdo desta página não for da Educação, ou não trouxer contato dela:
  - Etapa "geral": aceite e-mail/telefone institucional da prefeitura (ouvidoria, fale-conosco, secretaria geral).
  - Etapa "gabinete": aceite contato do gabinete do prefeito ou do próprio prefeito.

NUNCA invente. Só extraia o que aparece literalmente no texto.
Marque confianca="alta" só quando o alvo da etapa estiver claramente identificado.
```

Ajustar também os badges/labels do card pra refletir essa hierarquia ("Contato direto da Educação" / "Contato geral da prefeitura" / "Gabinete do prefeito — último recurso").

### 5. Tipos

- `src/lib/prospect.types.ts`: adicionar `ProgressEvent` (discriminated union dos tipos acima).
- `RunningCard.events: ProgressEvent[]` no `index.tsx`.

## Arquivos tocados

- `src/lib/prospect.types.ts` — adicionar `ProgressEvent`.
- `src/lib/prospect.server.ts` — assinatura com `onEvent`, prompts reforçados, emissões em cada etapa.
- `src/routes/api/prospect.ts` — **novo**, server route NDJSON streaming.
- `src/lib/prospect.functions.ts` — remover (ou manter como wrapper não-streaming).
- `src/routes/index.tsx` — consumir stream, alimentar `events` + `debug-log`.
- `src/components/ResultCard.tsx` — timeline ao vivo.
- `src/lib/debug-log.ts` — sem mudanças (já é genérico).
- `src/routes/debug.tsx` — sem mudanças estruturais; ganha eventos de prospecção "de graça".

## Fora do escopo

- Persistência dos logs entre reloads.
- Cancelamento de busca em andamento (pode ser próximo passo).

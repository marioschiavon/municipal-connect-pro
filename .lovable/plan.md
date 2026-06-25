## Resposta rápida sobre as duas fontes

**Querido Diário (Open Knowledge Brasil)** — Sim, vale muito a pena. É uma API pública e gratuita (`queridodiario.ok.org.br/api`) que indexa diários oficiais municipais já com OCR e busca por texto. Cobertura ~1.800 municípios. Ideal para descobrir **nome do(a) Secretário(a) de Educação** via portarias e decretos de nomeação/exoneração — exatamente o tipo de pista que o site da prefeitura raramente expõe.

**Portal da Transparência (federal, portaltransparencia.gov.br)** — Pouco útil para o nosso caso. Ele é focado em recursos federais (servidores da União, convênios, despesas federais). Não lista secretários municipais nem traz contatos institucionais. Daria no máximo CNPJ da prefeitura e convênios do FNDE, que não ajudam na prospecção comercial.

**Portais municipais de transparência** (cada prefeitura tem o seu) — Aí sim costuma ter "estrutura administrativa" com nome do secretário e às vezes e-mail/telefone. Mas como cada município tem layout próprio, isso já é coberto pelo nosso scraper genérico atual.

**Recomendação**: integrar Querido Diário agora; pular Transparência federal; deixar portais municipais de transparência como uma query adicional no Firecrawl.

## Plano de implementação

### 1. Nova etapa "diário oficial" antes da extração final

Adicionar uma quarta fonte que roda **em paralelo à etapa 1 (Educação)**, não como fallback. O objetivo é enriquecer o nome do secretário mesmo quando o site da prefeitura achou só o e-mail genérico.

```text
[Busca site prefeitura] ──┐
                          ├──► [IA consolida] ──► resultado
[Busca Querido Diário] ───┘
```

### 2. Cliente Querido Diário (`src/lib/querido-diario.server.ts`)

- Endpoint: `GET https://queridodiario.ok.org.br/api/gazettes`
- Parâmetros: `territory_ids` (código IBGE de 7 dígitos), `querystring` (ex.: `"secretário de educação" OR "secretária de educação"`), `sort_by=relevance`, `size=5`, `published_since` (últimos 24 meses).
- Resposta traz `excerpts` com o trecho do diário onde o termo apareceu — perfeito para a IA extrair o nome.
- Sem chave de API, sem custo.

### 3. Mudanças em `src/lib/prospect.server.ts`

- Receber o **código IBGE** do município (já disponível em `src/lib/ibge.ts`) — vou passar pelo endpoint `/api/prospect`.
- Em `runEtapa("educacao", ...)`, antes de retornar, consultar o Querido Diário em paralelo. Se vier excerpts com nome plausível, juntar ao markdown enviado para a IA com uma seção `### Pistas do Diário Oficial`.
- A IA passa a ter duas fontes de evidência: site oficial + diário. Isso aumenta muito a chance de capturar o nome do secretário, que é o campo mais frágil hoje.
- Eventos de progresso novos: "Consultando diários oficiais de {município}…", "Encontrei N menções recentes a Secretário de Educação", "Sem diário indexado para esse município" (quando município não está coberto).

### 4. Mudanças no contrato `/api/prospect`

- Input passa a aceitar `ibgeId` (opcional, mas usado quando presente).
- Frontend (`src/routes/index.tsx`) já tem o `Municipio.id` — só passar adiante.

### 5. UI

- Sem mudanças visuais grandes. A timeline ao vivo já mostra os eventos novos automaticamente.
- No card final, quando o nome do secretário vier do diário, badge extra: "Nome confirmado via Diário Oficial".
- Atualizar o box "Como o robô procura" na coluna lateral para listar Querido Diário como segunda fonte.

### 6. Versão

- Bump para **Alpha v0.4** (alteração funcional, regra Alpha mantida).

## O que NÃO vou fazer agora

- Não integrar Portal da Transparência federal — baixo retorno para o caso de uso.
- Não criar página dedicada de diários — o uso é só interno, como fonte de pistas.
- Não persistir resultados de diário — busca on-demand a cada prospecção.

## Arquivos previstos

- **Criar**: `src/lib/querido-diario.server.ts`
- **Editar**: `src/lib/prospect.server.ts`, `src/lib/prospect.types.ts` (campos opcionais para origem do nome), `src/routes/api/prospect.ts` (aceitar `ibgeId`), `src/routes/index.tsx` (enviar `ibgeId` e atualizar texto do "Como o robô procura"), `src/components/ResultCard.tsx` (badge "via Diário Oficial"), `src/lib/version.ts` (Alpha v0.4).
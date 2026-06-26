## Diagnóstico (caso Umuarama + feedback)

1. **Nome não aparece**: Estágio 1 só processa snippets. Quando o snippet do topo é genérico, a IA devolve `secretario: null` e nunca scrapeamos a página real — que tem nome + e-mail + telefone + horário visíveis.
2. **Snippets pouco aproveitados** entre estágios (refazemos buscas parecidas).
3. **E-mails de escolas/CMEIs vazando** para o resultado (ex.: `escolajoaodasilva@…`, `cmeiagua…@…`) — ranking não penaliza isso.
4. **Faltam fallbacks** que existiam antes: contato geral da prefeitura e do prefeito. Hoje, se a Secretaria falha, devolvemos "parcial" sem tentar geral/gabinete de forma robusta.
5. **Câmara Municipal**: a página de "Contato" da Câmara costuma listar e-mail/telefone gerais úteis — hoje usamos a Câmara só para tentar achar nome de secretário.
6. **Sem campo `horarioAtendimento`**, mesmo quando aparece literalmente na página.

## Plano (Alpha v0.13)

### 1. Scrape oportunista do TOP link (novo Estágio 1.5)
Se `rankedNome[0]` for página da Secretaria (URL/título casa `(secretaria|seduc|sme|smed|educa)` em `.gov.br`/`.leg.br`), scrapear **uma vez** e rodar `extractWithAI` com schema completo (modo "site"). Resolve o caso Umuarama em 1 busca + 1 scrape.

Se contato útil + `confianca ≠ baixa` → `sendFinal` e encerra.

### 2. Filtro anti-escola/CMEI (CRÍTICO)
Novo regex `SCHOOL_LOCAL_OR_DOMAIN`:
- locais: `^(escola|emef|emei|cmei|creche|cei|cmeb|cras|cmdca|conselho|biblioteca)`
- domínios contendo: `escola.`, `cmei.`, `emef.`, `creche.`
Aplicado em `rankEmails` como penalidade pesada e em `filterEmailsForFinal` como **exclusão** quando há alternativa não-escolar. Se TODOS os e-mails forem de escola/CMEI, descartamos e seguimos para o próximo estágio (não devolvemos como contato da Secretaria).

### 3. Cascata de fallback restaurada e clara
Reordenar o pipeline (após Estágios 1, 1.5, 2, 3 atuais):

- **Estágio 4 — Câmara Municipal (contato institucional)**: busca `"câmara municipal" ${municipio} ${uf} contato email telefone` + scrape da página `/contato` ou `/fale-conosco` quando localizada. O e-mail aqui é classificado como `geral`, não `educacao`.
- **Estágio 5 — Geral da prefeitura**: `prefeitura ${municipio} ${uf} ouvidoria contato e-mail telefone` (já existe, mantém).
- **Estágio 6 — Gabinete do prefeito**: `gabinete do prefeito ${municipio} ${uf} contato` (já existe, mantém).

Cada estágio respeita o filtro anti-escola. Se um e-mail útil aparecer no estágio 4/5/6, devolve com `hierarquia` correta (`geral` ou `gabinete`) e mantém o `secretario` (se conseguimos o nome no Estágio 1).

### 4. Reaproveitar snippets entre estágios
`snippetPool: SearchCandidate[]` acumulado e dedupado por URL. Cada `extractWithAI` recebe `snippetsBlock(pool)` adicional como contexto. Reduz buscas redundantes.

### 5. Refino do Estágio 1 (nome)
2ª busca paralela: `"secretaria municipal de educação" ${municipio} ${uf} site:gov.br`. Se IA devolver `secretario: null` e top for `.gov.br`, dispara o Estágio 1.5 mesmo sem nome (a página costuma trazer ambos).

### 6. Campo `horarioAtendimento`
- `ProspectResult.horarioAtendimento?: string | null` em `prospect.types.ts`.
- `ExtractSchema` ganha `horarioAtendimento: z.string().nullable().optional().default(null)`.
- Prompt instrui: "extraia o horário SOMENTE se aparecer literalmente (ex.: 'Seg a Sex 8h–17h')".
- `ResultCard` mostra "🕒 Horário: …" quando presente; `export.ts` adiciona coluna `Horário`.

### 7. Ranking de e-mails com bônus de domínio do `topResult`
Quando `extractWithAI` recebe scrape de `educacao.umuarama.pr.gov.br`, e-mails com esse domínio ganham bônus extra — confirma origem.

### 8. Sem banco de dados agora
O cache em `localStorage` (`result-cache.ts`) atende. Adicionar DB agora aumenta complexidade sem ganho proporcional. Revisitamos se precisar compartilhar cache entre usuários.

### 9. Bump versão
`src/lib/version.ts` → `Alpha v0.13`.

## Arquivos tocados
- `src/lib/prospect.types.ts` — campo `horarioAtendimento`.
- `src/lib/prospect.server.ts` — Estágio 1.5 scrape oportunista; 2ª busca paralela no Estágio 1; `snippetPool` compartilhado; filtro anti-escola; Estágio 4 Câmara/contato; cascata restaurada para geral/gabinete; bônus de domínio no `rankEmails`; horário no prompt/schema.
- `src/components/ResultCard.tsx` — linha de horário; rótulo de hierarquia (Secretaria / Geral / Gabinete / Câmara).
- `src/lib/export.ts` — coluna `Horário`.
- `src/lib/version.ts` — `Alpha v0.13`.

## Validação
- **Umuarama/PR**: Estágio 1.5 fecha com nome + `seduc@…` + telefone + horário em 1 scrape.
- **Maringá/PR** (regressão): continua entregando `seduc@maringa.pr.gov.br` + nome correto.
- Município sem SEDUC online: passa pra Câmara → geral → gabinete e devolve `hierarquia` correta.
- Nenhum resultado final contém e-mail de escola/CMEI quando existe alternativa institucional.
- `/debug` mostra `Estágio 1.5 — scrape oportunista` e `horarioAtendimento` no JSON quando aplicável.

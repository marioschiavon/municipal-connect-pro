## Diagnóstico

Hoje o Estágio A tenta resolver nome + contato numa única busca/IA. Quando o snippet traz "ouvidoria@", a IA pega esse e-mail e o pipeline encerra como sucesso, sem nunca rodar uma busca dedicada ao contato da Secretaria de Educação.

A correção é voltar ao modelo **escalonado de verdade**: primeiro fechar o NOME ATUAL, depois (e só depois) ir atrás do contato em ondas, cada uma mais ampla que a anterior.

## Plano (Alpha v0.12)

### Estágio 1 — Nome atual (apenas nome)
- Busca: `secretário OR secretária de educação {munic} {uf} {ano} atual` (snippet-only, `tbs: qdr:y`).
- IA com schema reduzido (`{ secretario, cargo, dataReferencia, confianca }`) — proibida de devolver e-mail/telefone aqui.
- Se Diário Oficial estiver ligado e nome ≤ 365 dias, entra como pista no prompt; conflito → IA prevalece (mantém regra atual).
- Sai daqui com `nomeSecretario` (pode ser null).

### Estágio 2 — Contato vinculado ao nome (quando há nome)
Executar em sequência, parar assim que `hasUsefulContact` for verdadeiro:

1. `"{nome}" "secretaria de educação" {munic} {uf}` — snippet-only.
2. `"{nome}" {munic} {uf} (email OR e-mail OR telefone OR contato)` — snippet-only.
3. Scrape do 1º resultado `.gov.br` (preferindo domínio do município) das duas buscas acima.

### Estágio 3 — Contato institucional da Secretaria (sem o nome)
1. `"secretaria municipal de educação" {munic} {uf} (email OR contato OR telefone)` — snippet-only.
2. `secretaria de educação {munic} {uf} site:gov.br` — snippet-only.
3. `"secretaria de educação" {munic} {uf} site:{slug}.{uf}.leg.br` (Câmara Municipal costuma listar secretários e contatos) — snippet-only.
4. Scrape do melhor `.gov.br` / `.leg.br`.

### Estágio 4 — Fallback institucional (mantém atual)
Geral da prefeitura → Gabinete do Prefeito (lógica já existente em `prospect.server.ts`, só precisa ser religada depois do Estágio 3).

### Regras de seleção de e-mail (todos os estágios)
Helper `rankEmails(emails, municipio, uf)`:
- Bônus: contém `seduc`, `educacao`, `educa`; domínio bate `{slug}.{uf}.gov.br` ou subdomínio `educacao.*`.
- Penalidade quando há alternativa: `ouvidoria@`, `faleconosco@`, `falecom@`, `contato@`, `imprensa@`, `gabinete@`, `prefeito@`.
- Antes do `sendFinal`, ordenar e cortar os penalizados se existir e-mail bom.

### Anti-alucinação
Após cada chamada de IA, filtrar `emails`/`telefones` mantendo apenas os que aparecem literalmente no texto enviado (case-insensitive para e-mail, dígitos normalizados para telefone).

### Prompt de contato
Adicionar bloco "REGRAS DE E-MAIL" no `extractWithAI`: priorize Educação (`seduc@`, `educacao@`), evite `ouvidoria/faleconosco/contato/imprensa/gabinete` salvo se únicos, retorne ordenados do mais específico para o mais genérico.

### Telemetria
Cada estágio emite `emit("info", etapa, "Estágio N — …")` com `elapsedMs` (já existe) para inspecionar no `/debug`.

## Arquivos tocados
- `src/lib/prospect.server.ts` — reorganizar `prospectar` em estágios 1→4; novo `extractNomeWithAI` (schema só de nome); helper `rankEmails`; validação literal de contato.
- `src/lib/version.ts` — bump para `Alpha v0.12`.

## Como validar
Maringá/PR no `/debug`:
- Estágio 1 fecha com nome atual (Adriana …).
- Estágio 2.1 já encontra `seduc@maringa.pr.gov.br` no snippet.
- Resultado final lista `seduc@…` antes de qualquer `ouvidoria@` (ou sem ela).
- Nenhum contato no resultado que não esteja no texto-fonte.

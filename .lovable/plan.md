## O que aconteceu

Nos logs do console aparece, nas 3 etapas (Educação, Geral, Gabinete) de Umuarama/PR:

```
AI_NoObjectGeneratedError: No object generated: response did not match schema.
```

Conferi os logs do AI Gateway dos mesmos horários (22:32:55, 22:33:00, 22:33:04). **Os 3 retornaram HTTP 200** — ou seja, o gateway e o Gemini 3 Flash responderam normalmente (1126, 188 e 120 tokens de saída). O erro **não é** rate limit, créditos, chave inválida ou timeout.

O erro acontece **do lado do AI SDK**, depois da resposta chegar: o texto que o Gemini devolveu não passou na validação do schema Zod que pedimos via `experimental_output: Output.object({ schema: ExtractSchema })` em `src/lib/prospect.server.ts:214-218`.

## Por que está falhando

`generateText` + `experimental_output` é uma rota experimental do AI SDK: ela injeta instruções de JSON no prompt e tenta fazer `JSON.parse` + Zod no texto bruto. Com Gemini 3 Flash isso quebra em três cenários comuns, e os 3 estão batendo no nosso caso:

1. **Resposta de 1126 tokens na 1ª chamada** (Educação, página de 25k chars com dezenas de e-mails de CMEIs) — o modelo provavelmente devolveu raciocínio + JSON, ou um array grande embrulhado em ```json ... ```, e o parser do `experimental_output` não tolera prefixo/sufixo.
2. **Enum estrito** (`confianca: "alta" | "media" | "baixa"`) — Gemini às vezes devolve `"média"` (com acento) ou `"medium"`, e o Zod rejeita.
3. **Campos `nullable`** — Gemini às vezes omite a chave em vez de mandar `null`, e o Zod rejeita.

Como `extractWithAI` retorna `null` quando isso acontece, `hasUsefulContact` vira `false` e cai pro próximo fallback — mesmo a página tendo `gabinete@umuarama.pr.gov.br` literal nas pistas regex. Foi isso que você viu: "Não encontrei nada utilizável em nenhuma das três etapas", mesmo com o regex já tendo achado os contatos.

## Plano de correção (Alpha v0.2 → v0.3)

### 1. Trocar `generateText + experimental_output` por `generateObject`
Em `src/lib/prospect.server.ts`, função `extractWithAI`:
- Importar `generateObject` de `"ai"`.
- Substituir a chamada por:
  ```ts
  const { object } = await generateObject({
    model: provider("google/gemini-3-flash-preview"),
    schema: ExtractSchema,
    prompt,
  });
  ```
- `generateObject` usa o modo JSON nativo do provider (mais robusto que o `experimental_output`) e já trata o caso de texto wrapper em ```json.

### 2. Afrouxar o schema para reduzir rejeições falsas
- `emails` e `telefones`: `.array(z.string()).default([])` para que a chave possa vir ausente.
- `confianca`: aceitar variações comuns — `z.enum([...]).or(z.string().transform(s => normalizeConfianca(s)))` mapeando "média"/"medium"/"high" etc. para os 3 valores canônicos.
- `secretario`, `cargo`, `contexto`: `.nullable().optional().default(null)`.

### 3. Fallback de emergência: usar as pistas regex
Se mesmo com `generateObject` a chamada falhar (catch), em vez de devolver `null` direto, montar um `Extracted` mínimo a partir de `extractContactsRegex(markdown)` com `confianca: "baixa"` e `contexto: "IA falhou — contatos extraídos por regex da página"`. Isso evita perder dados quando o regex já tinha visto `gabinete@umuarama.pr.gov.br`.

### 4. Reforçar o prompt
- Adicionar no final: `Responda APENAS com JSON válido, sem comentários, sem markdown, sem \`\`\`json.`
- Reduzir o `markdown.slice(0, 18000)` para `slice(0, 12000)` na etapa Educação quando a página é gigante (caso Umuarama 25k chars), para diminuir alucinação/raciocínio extenso.

### 5. Melhorar o log de erro no /debug
Hoje o emit mostra só `String(e)`. Trocar por algo como:
```ts
emit("error", etapa, "Erro na IA: schema não bateu", {
  message: e.message,
  cause: e.cause?.message,
  rawText: e.text?.slice(0, 500), // quando NoObjectGeneratedError, o SDK expõe .text
});
```
Assim, no /debug você vê o JSON cru que o Gemini devolveu e a gente confirma o motivo real da rejeição.

### 6. Bump de versão
`src/lib/version.ts`: `Alpha v0.2` → `Alpha v0.3`.

## O que NÃO vou mexer

- Hierarquia de fallback (Educação → Geral → Gabinete) — está correta.
- Scraper nativo + Firecrawl — funcionou, baixou as 3 páginas.
- UI / streaming / cancelamento.

## Resultado esperado

Rodando Umuarama/PR de novo:
- Etapa Educação: IA deve devolver `educacao@umuarama.pr.gov.br` + telefone (44) 2030-4050 com confiança alta → card finaliza no 1º passo, sem fallback.
- Se mesmo assim a IA falhar pontualmente, o card cai pro fallback regex e mostra os e-mails que já estavam nas pistas, em vez de "not_found".

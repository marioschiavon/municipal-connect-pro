## MunicipIA — Alpha v0.1

Ferramenta web para buscar e extrair contatos de Secretarias de Educação municipais, com fallback hierárquico (Educação → Secretaria Geral → Gabinete) usando Firecrawl + Lovable AI.

## Stack
- Frontend: TanStack Start + React + Tailwind + shadcn/ui
- Backend: server functions TanStack + Firecrawl (search/scrape) + Lovable AI Gateway (gemini-3-flash-preview) para extração estruturada
- Sem auth, sem persistência (resultados ficam só na sessão atual)

## Secrets
- `FIRECRAWL_API_KEY` — armazenada via `add_secret` (a chave que você compartilhou). Idealmente conectar o Firecrawl connector depois para gestão automática.
- `LOVABLE_API_KEY` — auto-provisionada para a extração via IA.

## Layout

**Header (branco, minimal)**
- "MunicipIA" + badge "Alpha v0.1" ao lado
- Subtítulo: "Coleta inteligente de contatos municipais"

**Coluna esquerda (30%)**
- Combobox com autocomplete da lista IBGE (`servicodados.ibge.gov.br/api/v1/localidades/municipios`) carregada uma vez no client e filtrada localmente
- Sugestões "Nome — UF"
- Chips dos selecionados (máx. 5; ao atingir, input desabilita com aviso)
- Botão "Iniciar busca" (ativo se ≥1 selecionado; desabilita durante execução)
- Botão "Limpar tudo"

**Área central (70%)**
- Estado vazio: ícone + texto explicativo
- Durante busca: um card por município, criado quando aquela busca começa (sequencial)
- Cada card mostra:
  - Município + UF
  - Status animado: Buscando… → Analisando… → Concluído ✓ / Parcial ⚠ / Não encontrado ✗
  - Campos progressivos: Secretário(a), Cargo, E-mail(s), Telefone(s), Fonte, Contexto
  - Badge hierarquia: 🟢 Educação · 🟡 Geral · 🔵 Gabinete
  - Aviso "Levando mais tempo que o esperado…" após 30s

**Rodapé de resultados**
- "Exportar CSV" e "Exportar Excel (.xlsx)" (desabilitados durante busca)
- Linha + texto centralizado 11px cinza: "Powered by Leaderei · Desenvolvido por S7"

## Lógica de busca (server function `prospectarMunicipio`)

Para cada município, sequencialmente no cliente (`for…of` + `await`):

1. **Etapa 1 — Site oficial da prefeitura**
   - `firecrawl.search("prefeitura municipal {nome} {UF} secretaria de educação", limit: 5)`
   - Selecionar resultado preferindo domínios `.gov.br` com "prefeitura"/"educacao" no slug
   - `firecrawl.scrape(url, formats: ['markdown'], onlyMainContent: true)`
   - Chamar Lovable AI com `Output.object` (Zod): `{ secretario, cargo, emails[], telefones[], contexto, confianca }`
   - Se houver e-mail OU telefone com confiança ≥ media → badge 🟢, encerra
2. **Etapa 2 — Secretaria Geral**
   - Search: "secretaria geral prefeitura {nome} {UF} contato e-mail"
   - Scrape + extração IA → badge 🟡, contexto "Secretaria geral/multifuncional"
3. **Etapa 3 — Gabinete do Prefeito**
   - Search: "gabinete do prefeito {nome} {UF} contato"
   - Scrape + extração IA → badge 🔵, contexto "Contato direto com o gabinete"
4. Se todas falharem → "Não encontrado ✗"

UX de progresso: cliente coloca o card como "Buscando…", troca para "Analisando…" após ~3s via timer, e finaliza ao retorno da server function.

## Exportação (client-side)
- **CSV**: UTF-8 com BOM (`\uFEFF`), separador `;`, colunas: Município, UF, Secretário(a), Cargo, E-mail, Telefone, Fonte, Hierarquia, Data da Busca. Arquivo `municipia_contatos_AAAA-MM-DD.csv`
- **XLSX**: SheetJS (`xlsx`). Cabeçalho em negrito + fundo cinza claro, larguras auto. `municipia_contatos_AAAA-MM-DD.xlsx`

## Arquivos
- `src/routes/index.tsx` — UI principal
- `src/routes/__root.tsx` — título/meta
- `src/components/MunicipioCombobox.tsx`
- `src/components/ResultCard.tsx`
- `src/components/ExportButtons.tsx`
- `src/lib/ibge.ts` — fetch + cache da lista IBGE
- `src/lib/ai-gateway.server.ts` — provider helper (Lovable AI Gateway)
- `src/lib/prospect.server.ts` — Firecrawl + IA + lógica das 3 etapas
- `src/lib/prospect.functions.ts` — `prospectarMunicipio` (createServerFn)
- `src/lib/export.ts` — CSV/XLSX

## Dependências novas
`@mendable/firecrawl-js`, `xlsx`, `ai`, `@ai-sdk/openai-compatible`

## Design
- Branco / cinzas; cores apenas nos badges (verde/amarelo/azul)
- Inter (sistema), tipografia contida
- Cards com borda fina, sem sombras pesadas
- Spinners discretos (lucide `Loader2`)

## Fora de escopo (Alpha)
- Persistência / histórico
- Auth
- Querido Diário (confirmado: fora)
- Busca em paralelo (proposital para sensação de progresso)

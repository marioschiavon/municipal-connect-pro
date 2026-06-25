## Problema

O carregamento de municípios do IBGE está falhando com:
`TypeError: Cannot read properties of null (reading 'mesorregiao')`

Alguns municípios retornados pela API do IBGE têm o campo `microrregiao` como `null` (distritos/municípios novos), o que quebra o parser inteiro — nenhum município é carregado e a busca fica vazia.

## Correção

Atualizar `src/lib/ibge.ts` para extrair a UF de forma resiliente, tentando múltiplos caminhos do payload do IBGE:

1. `municipio['regiao-imediata']['regiao-intermediaria'].UF.sigla` (caminho mais novo e estável)
2. `municipio.microrregiao.mesorregiao.UF.sigla` (caminho legado, usado hoje)
3. Pular o registro se nenhum caminho funcionar (em vez de derrubar todo o `.map`)

Sem outras mudanças — o `MunicipioCombobox` já funciona corretamente quando a lista é populada.
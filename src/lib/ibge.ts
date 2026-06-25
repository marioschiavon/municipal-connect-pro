export type Municipio = {
  id: number;
  nome: string;
  uf: string;
};

let cache: Municipio[] | null = null;
let inflight: Promise<Municipio[]> | null = null;

export async function loadMunicipios(): Promise<Municipio[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(
      "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome",
    );
    if (!res.ok) throw new Error("Falha ao carregar municípios do IBGE");
    const data = await res.json();
    cache = data.map((m: { id: number; nome: string; microrregiao: { mesorregiao: { UF: { sigla: string } } } }) => ({
      id: m.id,
      nome: m.nome,
      uf: m.microrregiao.mesorregiao.UF.sigla,
    }));
    return cache!;
  })();
  return inflight;
}

export function normalize(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

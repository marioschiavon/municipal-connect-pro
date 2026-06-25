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
    const data = (await res.json()) as Array<Record<string, any>>;
    const out: Municipio[] = [];
    for (const m of data) {
      const uf: string | undefined =
        m?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla ??
        m?.microrregiao?.mesorregiao?.UF?.sigla;
      if (!uf || typeof m.id !== "number" || typeof m.nome !== "string") continue;
      out.push({ id: m.id, nome: m.nome, uf });
    }
    cache = out;
    return cache;
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

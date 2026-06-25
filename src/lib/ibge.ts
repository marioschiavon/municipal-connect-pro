import { logDebug } from "./debug-log";

export type Municipio = {
  id: number;
  nome: string;
  uf: string;
};

let cache: Municipio[] | null = null;
let inflight: Promise<Municipio[]> | null = null;

export async function loadMunicipios(): Promise<Municipio[]> {
  if (cache) {
    logDebug("info", "ibge", `Cache hit: ${cache.length} municípios`);
    return cache;
  }
  if (inflight) {
    logDebug("info", "ibge", "Requisição já em andamento, aguardando...");
    return inflight;
  }
  logDebug("info", "ibge", "Iniciando fetch IBGE /localidades/municipios");
  inflight = (async () => {
    const t0 = performance.now();
    const res = await fetch(
      "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome",
    );
    logDebug("info", "ibge", `Resposta HTTP ${res.status}`, {
      ok: res.ok,
      ms: Math.round(performance.now() - t0),
    });
    if (!res.ok) {
      logDebug("error", "ibge", "Falha ao carregar municípios do IBGE");
      throw new Error("Falha ao carregar municípios do IBGE");
    }
    const data = (await res.json()) as Array<Record<string, any>>;
    logDebug("info", "ibge", `Payload recebido: ${data.length} registros brutos`);

    const out: Municipio[] = [];
    let viaRegiaoImediata = 0;
    let viaMicrorregiao = 0;
    let skipped = 0;
    const skippedSamples: unknown[] = [];

    for (const m of data) {
      const ufImediata = m?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla;
      const ufMicro = m?.microrregiao?.mesorregiao?.UF?.sigla;
      const uf: string | undefined = ufImediata ?? ufMicro;

      if (!uf || typeof m.id !== "number" || typeof m.nome !== "string") {
        skipped++;
        if (skippedSamples.length < 3) {
          skippedSamples.push({
            id: m?.id,
            nome: m?.nome,
            hasRegiaoImediata: !!m?.["regiao-imediata"],
            hasMicrorregiao: !!m?.microrregiao,
          });
        }
        continue;
      }
      if (ufImediata) viaRegiaoImediata++;
      else viaMicrorregiao++;
      out.push({ id: m.id, nome: m.nome, uf });
    }

    logDebug(
      skipped > 0 ? "warn" : "success",
      "ibge",
      `Parse concluído: ${out.length} válidos / ${skipped} ignorados`,
      {
        total: data.length,
        validos: out.length,
        viaRegiaoImediata,
        viaMicrorregiao,
        ignorados: skipped,
        amostrasIgnoradas: skippedSamples,
      },
    );

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

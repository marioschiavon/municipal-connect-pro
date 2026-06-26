export type Hierarquia = "educacao" | "geral" | "gabinete";

export type ProspectResult = {
  status: "found" | "partial" | "not_found";
  hierarquia: Hierarquia | null;
  secretario: string | null;
  cargo: string | null;
  emails: string[];
  telefones: string[];
  fonte: string | null;
  fonteUrl: string | null;
  contexto: string | null;
  /** Origem do NOME do secretário, quando aplicável. */
  nomeFonte?: "site" | "diario" | "busca-nome" | "snippet" | null;
  /** Data/período de referência da informação (ex.: "2025-11", "abril/2025"). */
  dataReferencia?: string | null;
};

export type ProgressLevel = "info" | "success" | "warn" | "error";

export type EtapaTag =
  | Hierarquia
  | "init"
  | "fallback"
  | "final"
  | "diario"
  | "nome"
  | "contato-secretario";

export type ProgressEvent =
  | {
      kind: "progress";
      level: ProgressLevel;
      etapa: EtapaTag;
      message: string;
      data?: unknown;
      ts: number;
      /** Milissegundos decorridos desde o início da prospecção deste município. */
      elapsedMs?: number;
    }
  | {
      kind: "final";
      result: ProspectResult;
      ts: number;
      elapsedMs?: number;
    };


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
  /** Origem do NOME do secretário, quando aplicável ("diario" = Querido Diário). */
  nomeFonte?: "site" | "diario" | null;
};

export type ProgressLevel = "info" | "success" | "warn" | "error";

export type ProgressEvent =
  | {
      kind: "progress";
      level: ProgressLevel;
      etapa: Hierarquia | "init" | "fallback" | "final" | "diario";
      message: string;
      data?: unknown;
      ts: number;
    }
  | {
      kind: "final";
      result: ProspectResult;
      ts: number;
    };

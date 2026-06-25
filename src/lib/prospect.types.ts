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
};

export type ProgressLevel = "info" | "success" | "warn" | "error";

export type ProgressEvent =
  | {
      kind: "progress";
      level: ProgressLevel;
      etapa: Hierarquia | "init" | "fallback" | "final";
      message: string;
      data?: unknown;
      ts: number;
    }
  | {
      kind: "final";
      result: ProspectResult;
      ts: number;
    };

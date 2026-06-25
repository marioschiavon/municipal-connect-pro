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

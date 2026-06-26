import * as XLSX from "xlsx";
import type { ProspectResult } from "./prospect.types";

export type ExportRow = {
  municipio: string;
  uf: string;
  result: ProspectResult;
  buscadoEm: string;
};

const headers = [
  "Município",
  "UF",
  "Secretário(a)",
  "Cargo",
  "E-mail",
  "Telefone",
  "Horário",
  "Fonte",
  "Hierarquia",
  "Data da Busca",
];

function rowFor(r: ExportRow) {
  const hierMap: Record<string, string> = {
    educacao: "Secretaria de Educação",
    geral: "Secretaria Geral",
    gabinete: "Gabinete do Prefeito",
  };
  return [
    r.municipio,
    r.uf,
    r.result.secretario ?? "",
    r.result.cargo ?? "",
    r.result.emails.join("; "),
    r.result.telefones.join("; "),
    r.result.horarioAtendimento ?? "",
    r.result.fonte ?? "",
    r.result.hierarquia ? hierMap[r.result.hierarquia] : "",
    r.buscadoEm,
  ];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v: string) {
  if (/[";\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function exportCSV(rows: ExportRow[]) {
  const lines = [headers.map(csvEscape).join(";")];
  for (const r of rows) {
    lines.push(rowFor(r).map((v) => csvEscape(String(v))).join(";"));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  download(blob, `municipia_contatos_${today()}.csv`);
}

export function exportXLSX(rows: ExportRow[]) {
  const aoa = [headers, ...rows.map(rowFor)];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Larguras automáticas (aproximação)
  const colWidths = headers.map((h, i) => {
    const maxLen = Math.max(
      h.length,
      ...rows.map((r) => String(rowFor(r)[i] ?? "").length),
    );
    return { wch: Math.min(Math.max(maxLen + 2, 12), 50) };
  });
  ws["!cols"] = colWidths;
  // Estilo do cabeçalho (xlsx sem styles avançados — mantém em negrito via cellStyles quando suportado)
  for (let c = 0; c < headers.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = ws[addr];
    if (cell) {
      cell.s = {
        font: { bold: true },
        fill: { fgColor: { rgb: "EEEEEE" } },
      };
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contatos");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  download(blob, `municipia_contatos_${today()}.xlsx`);
}

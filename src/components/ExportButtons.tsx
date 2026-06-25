import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportCSV, exportXLSX, type ExportRow } from "@/lib/export";

export function ExportButtons({ rows, disabled }: { rows: ExportRow[]; disabled: boolean }) {
  const noData = rows.length === 0;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || noData}
        onClick={() => exportCSV(rows)}
      >
        <Download className="mr-2 h-4 w-4" /> Exportar CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || noData}
        onClick={() => exportXLSX(rows)}
      >
        <Download className="mr-2 h-4 w-4" /> Exportar Excel (.xlsx)
      </Button>
    </div>
  );
}

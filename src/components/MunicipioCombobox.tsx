import { useEffect, useMemo, useRef, useState } from "react";
import { loadMunicipios, normalize, type Municipio } from "@/lib/ibge";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

type Props = {
  onSelect: (m: Municipio) => void;
  disabled?: boolean;
  selectedIds: number[];
};

export function MunicipioCombobox({ onSelect, disabled, selectedIds }: Props) {
  const [all, setAll] = useState<Municipio[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMunicipios()
      .then((data) => setAll(data))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const suggestions = useMemo(() => {
    if (!all || query.trim().length < 2) return [];
    const q = normalize(query);
    const selectedSet = new Set(selectedIds);
    const out: Municipio[] = [];
    for (const m of all) {
      if (selectedSet.has(m.id)) continue;
      if (normalize(m.nome).includes(q) || `${normalize(m.nome)} ${m.uf.toLowerCase()}`.includes(q)) {
        out.push(m);
        if (out.length >= 12) break;
      }
    }
    return out;
  }, [all, query, selectedIds]);

  function choose(m: Municipio) {
    onSelect(m);
    setQuery("");
    setOpen(false);
    setActiveIdx(0);
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Input
          placeholder={loading ? "Carregando municípios..." : "Digite o nome do município"}
          value={query}
          disabled={disabled || loading}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open || suggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(suggestions[activeIdx]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="bg-white"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-white shadow-md">
          {suggestions.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => choose(m)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                i === activeIdx ? "bg-gray-100" : ""
              }`}
            >
              <span className="text-foreground">{m.nome}</span>
              <span className="text-xs font-medium text-muted-foreground">{m.uf}</span>
            </button>
          ))}
        </div>
      )}
      {open && query.trim().length >= 2 && suggestions.length === 0 && !loading && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-white p-3 text-sm text-muted-foreground shadow-md">
          Nenhum município encontrado
        </div>
      )}
    </div>
  );
}

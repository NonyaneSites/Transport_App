import { useRef, useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { parseWorkbook, type ParseResult } from '@/lib/parser';
import type { Passenger, ServiceType } from '@/lib/types';

interface Props {
  date: string;
  service: ServiceType;
  onImport: (passengers: Passenger[], result: ParseResult) => void;
  existingCount: number;
}

export function ExcelUpload({ date, service, onImport, existingCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [lastResult, setLastResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFile(file: File) {
    setParsing(true);
    setError(null);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const result = parseWorkbook(buf, { selectedDate: date, selectedService: service });
      setLastResult(result);
      if (result.passengers.length > 0) {
        onImport(result.passengers, result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse file.');
    } finally {
      setParsing(false);
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div className="card">
      <div className="mb-4 flex items-center gap-2">
        <div className="h-5 w-1 rounded-full bg-crimson-500" />
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Excel / CSV Upload</h2>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className="group relative cursor-pointer rounded-xl border-2 border-dashed border-line bg-card-2/50 p-6 text-center transition-all hover:border-crimson-500/50 hover:bg-crimson-900/5"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onInputChange}
          className="hidden"
        />
        {parsing ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-crimson-400" />
            <p className="text-sm text-muted">Parsing {fileName}…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-crimson-500/15 border border-crimson-500/30 transition-transform group-hover:scale-110">
              <Upload className="h-6 w-6 text-crimson-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">
                Drop Microsoft Forms export here or click to browse
              </p>
              <p className="mt-0.5 text-xs text-muted">Supports .xlsx, .xls, .csv</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-3 text-sm text-crimson-300 animate-fade-in">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {lastResult && !parsing && (
        <div className="mt-4 space-y-3 animate-fade-in">
          <div className="flex items-center gap-2 text-sm font-semibold text-success-light">
            <CheckCircle2 className="h-4 w-4" />
            Import complete
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Rows Parsed" value={lastResult.totalRows} />
            <Stat label="Wants Transport" value={lastResult.matchedTransport} />
            <Stat label="Date Matched" value={lastResult.matchedDate} />
            <Stat label="Imported" value={lastResult.passengers.length} accent />
          </div>
          {lastResult.skipped > 0 && (
            <p className="text-xs text-muted">
              {lastResult.skipped} row(s) skipped — no transport needed, different date, different service, or duplicate.
            </p>
          )}
          {lastResult.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-2.5 text-xs text-yellow-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          {existingCount > 0 && (
            <p className="text-xs text-muted">
              Merged with {existingCount} existing signups. Duplicates were skipped.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 text-center ${accent ? 'border-success/40 bg-success/10' : 'border-line bg-card-2'}`}>
      <div className={`font-display text-xl font-bold ${accent ? 'text-success-light' : 'text-ink'}`}>{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

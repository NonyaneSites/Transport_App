import React, { useRef, useState } from 'react';
import {
  Upload, AlertTriangle, Loader2, FileSpreadsheet,
  ChevronDown, ChevronRight, Calendar, UserCheck
} from 'lucide-react';
import type { Passenger } from '@/lib/types';
import { isDreamWeekDate, DREAMWEEK_FARE } from '@/lib/types';
import { prettyDate, shortDate } from '@/lib/dates';
import {
  parseRehearsalSheet,
  type ParsedRehearsalRecord,
  type RehearsalImportSummary,
} from '@/lib/rehearsal';

interface Props {
  date: string;
  onImport: (passengers: Passenger[]) => void;
  existingCount: number;
}

export function ThursdayRehearsalUpload({ date, onImport, existingCount }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<RehearsalImportSummary | null>(null);
  const [intercessionList, setIntercessionList] = useState<ParsedRehearsalRecord[]>([]);
  const [privateList, setPrivateList] = useState<ParsedRehearsalRecord[]>([]);
  const [showIntercessionSection, setShowIntercessionSection] = useState(false);
  const [showPrivateSection, setShowPrivateSection] = useState(false);
  const [includedExcludedIds, setIncludedExcludedIds] = useState<Set<string>>(new Set());

  const isDW = isDreamWeekDate(date);

  async function processWorkbook(buffer: ArrayBuffer, targetDate: string, fileTitle: string) {
    setParsing(true);
    setError(null);
    setFileName(fileTitle);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buffer, { type: 'array' });
      // Find sheet "Form Responses 2" or first available sheet
      let sheetName = wb.SheetNames.find((s) => s.toLowerCase().includes('form responses 2'));
      if (!sheetName) sheetName = wb.SheetNames[0];

      const sheet = wb.Sheets[sheetName];
      if (!sheet) {
        throw new Error('Workbook is empty or cannot be read.');
      }
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

      const result = parseRehearsalSheet(rawRows, targetDate);
      setImportSummary(result.summary);
      setIntercessionList(result.intercessionExcluded);
      setPrivateList(result.privateExcluded);

      const importedPassengers = result.included.map((r) => r.passenger);
      if (importedPassengers.length > 0) {
        onImport(importedPassengers);
      } else if (result.summary.totalResponsesForDate === 0) {
        setError(`No form submissions found matching ${prettyDate(targetDate)} in sheet "${sheetName}".`);
      }
    } catch (err) {
      console.error('Failed to parse rehearsal workbook:', err);
      setError(err instanceof Error ? err.message : 'Failed to parse rehearsal spreadsheet.');
    } finally {
      setParsing(false);
    }
  }

  async function handleFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      await processWorkbook(buffer, date, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read file.');
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

  function handleIncludeRecord(record: ParsedRehearsalRecord) {
    const p = record.passenger;
    onImport([p]);
    setIncludedExcludedIds((prev) => new Set([...prev, record.id]));
  }

  return (
    <div className="card space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-1 rounded-full bg-indigo-500" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">
            Thursday Rehearsal Upload
          </h2>
        </div>
        {date && /^\d{4}-\d{2}-\d{2}$/.test(date) && (
          <div className="flex items-center gap-1.5 text-xs text-muted font-medium bg-card-2 px-2.5 py-1 rounded-lg border border-line">
            <Calendar className="h-3.5 w-3.5 text-indigo-400" />
            <span>Target: <strong className="text-ink">{shortDate(date)}</strong></span>
            {existingCount > 0 && <span className="text-indigo-300">({existingCount} on manifest)</span>}
            {isDW && (
              <span className="ml-1 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-indigo-300">
                DreamWeek · R{DREAMWEEK_FARE}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Upload Dropzone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className="group relative cursor-pointer rounded-xl border-2 border-dashed border-line bg-card-2/50 p-6 text-center transition-all hover:border-indigo-500/50 hover:bg-indigo-900/5"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onInputChange}
          className="hidden"
        />

        {parsing ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-7 w-7 animate-spin text-indigo-400" />
            <p className="text-sm font-semibold text-ink">Processing Rehearsal Google Form sheet…</p>
            <p className="text-xs text-muted">Filtering date, deduplicating, and calculating fares...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 border border-indigo-500/30">
              <Upload className="h-5 w-5 text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">
                Upload Google Form Spreadsheet ("Form Responses 2")
              </p>
              <p className="text-xs text-muted mt-0.5">
                Filters for <strong className="text-ink">{prettyDate(date)}</strong> · Automatically deduplicates (latest submission wins)
              </p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-crimson-500/30 bg-crimson-900/20 p-3 text-xs text-crimson-300 animate-fade-in">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Import Summary Card */}
      {importSummary && (
        <div className="rounded-xl bg-card-2/60 border border-line p-3.5 space-y-3 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2.5">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-indigo-400" />
              <span className="font-display text-xs font-bold uppercase tracking-wider text-ink">
                Import Summary
              </span>
              {fileName && <span className="text-[11px] text-muted">({fileName})</span>}
            </div>
            <div className="text-xs font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded">
              Expected Total Fare: R{importSummary.expectedTotalFare.toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted text-[11px]">Submissions</div>
              <div className="text-base font-bold text-ink">{importSummary.totalResponsesForDate}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted text-[11px]">Duplicates Removed</div>
              <div className="text-base font-bold text-amber-400">-{importSummary.duplicatesRemoved}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted text-[11px]">Manifest Passengers</div>
              <div className="text-base font-bold text-indigo-400">{importSummary.includedCount}</div>
            </div>
            <div className="rounded-lg bg-card p-2 border border-line">
              <div className="text-muted text-[11px]">Legs Breakdown</div>
              <div className="text-[11px] font-semibold text-ink mt-0.5">
                Both: {importSummary.legsBothCount} · Going: {importSummary.legsGoingCount} · Ret: {importSummary.legsReturnCount}
              </div>
            </div>
          </div>

          {/* Excluded sections */}
          <div className="space-y-2 pt-1">
            {intercessionList.length > 0 && (
              <div className="rounded-lg border border-line bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowIntercessionSection(!showIntercessionSection)}
                  className="flex w-full items-center justify-between p-2.5 text-xs font-semibold text-muted hover:text-ink transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <span>Intercession Taxi Excluded</span>
                    <span className="badge bg-indigo-500/15 text-indigo-300 font-mono text-[10px]">
                      {intercessionList.length}
                    </span>
                  </span>
                  {showIntercessionSection ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showIntercessionSection && (
                  <div className="p-2.5 border-t border-line space-y-1.5 text-xs max-h-48 overflow-y-auto">
                    <p className="text-[11px] text-muted mb-2">
                      These respondents selected Intercession taxi both ways or going only. Click "Include" to add them to Rehearsal:
                    </p>
                    {intercessionList.map((rec) => {
                      const isIncluded = includedExcludedIds.has(rec.id);
                      return (
                        <div key={rec.id} className="flex items-center justify-between py-1 border-b border-line/40 last:border-0">
                          <div>
                            <span className="font-semibold text-ink">{rec.passenger.fullName}</span>
                            <span className="text-muted ml-1.5">({rec.passenger.stop})</span>
                          </div>
                          {isIncluded ? (
                            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                              <UserCheck className="h-3 w-3" /> Included
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleIncludeRecord(rec)}
                              className="px-2 py-0.5 text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 rounded hover:bg-indigo-500/25 transition-colors"
                            >
                              Include
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {privateList.length > 0 && (
              <div className="rounded-lg border border-line bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowPrivateSection(!showPrivateSection)}
                  className="flex w-full items-center justify-between p-2.5 text-xs font-semibold text-muted hover:text-ink transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <span>Private Transport Excluded</span>
                    <span className="badge bg-card-2 text-muted font-mono text-[10px]">
                      {privateList.length}
                    </span>
                  </span>
                  {showPrivateSection ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showPrivateSection && (
                  <div className="p-2.5 border-t border-line space-y-1.5 text-xs max-h-48 overflow-y-auto">
                    <p className="text-[11px] text-muted mb-2">
                      These respondents selected private transport or indicated no transport needed:
                    </p>
                    {privateList.map((rec) => {
                      const isIncluded = includedExcludedIds.has(rec.id);
                      return (
                        <div key={rec.id} className="flex items-center justify-between py-1 border-b border-line/40 last:border-0">
                          <div>
                            <span className="font-semibold text-ink">{rec.passenger.fullName}</span>
                            <span className="text-muted ml-1.5">({rec.passenger.stop})</span>
                          </div>
                          {isIncluded ? (
                            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                              <UserCheck className="h-3 w-3" /> Included
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleIncludeRecord(rec)}
                              className="px-2 py-0.5 text-[10px] font-semibold bg-card-2 text-muted border border-line rounded hover:text-ink transition-colors"
                            >
                              Include
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

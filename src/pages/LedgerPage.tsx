import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Loader2, AlertTriangle, FileSpreadsheet, Search, Trash2, Filter, XCircle,
  ChevronDown, ChevronRight, Upload, CheckCircle2, FileText, Banknote, X, UserPlus, Plus,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  listLedgerEntries, deleteLedgerEntry, downloadLedgerExcel,
  aggregateLedgerEntries, parseHistoricalCancellationWorkbook, importHistoricalCancellations,
  recordPartialPayment, addManualLedgerEntry, evaluateLedgerSearch,
  type LedgerEntry, type AggregatedLedgerRow, type HistoricalImportResult,
} from '@/lib/ledger';
import { downloadCancellationDebtPdf } from '@/lib/pdfExport';
import { naturalCompare } from '@/lib/sort';

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q || !text) return <span>{text}</span>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="bg-crimson-500/30 text-crimson-200 font-bold px-0.5 rounded">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [structureFilter, setStructureFilter] = useState('');
  const [openStructures, setOpenStructures] = useState<Set<string>>(new Set());

  // Partial Payment Modal State
  const [paymentTarget, setPaymentTarget] = useState<AggregatedLedgerRow | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Manual Add Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [addFirstName, setAddFirstName] = useState('');
  const [addSurname, setAddSurname] = useState('');
  const [addStructure, setAddStructure] = useState('S1');
  const [addService, setAddService] = useState('PM');
  const [addAmount, setAddAmount] = useState('40');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addNotes, setAddNotes] = useState('');
  const [addIsSponsored, setAddIsSponsored] = useState(false);
  const [addingDebtor, setAddingDebtor] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccessMessage, setAddSuccessMessage] = useState<string | null>(null);

  // Historical Cancellation Import
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<HistoricalImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await listLedgerEntries();
        if (mounted) { setEntries(data); setLoading(false); }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const structures = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => { if (e.structure) set.add(e.structure); });
    return Array.from(set).sort(naturalCompare);
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q && !structureFilter) return entries;

    return entries.filter((e) => {
      if (structureFilter && e.structure !== structureFilter) return false;
      if (!q) return true;
      const { matched } = evaluateLedgerSearch(
        {
          passenger_name: e.passenger_name,
          structure: e.structure,
          general_notes: e.general_notes,
          sponsor_note: e.sponsor_note,
          date: e.date,
          service: e.service,
          rep_name: e.rep_name,
        },
        q
      );
      return matched;
    });
  }, [entries, search, structureFilter]);

  const totalDebt = filtered.reduce((sum, e) => sum + Number(e.structure_debt), 0);

  // Shared with the download (see aggregateLedgerEntries in lib/ledger) so
  // the web view and the exported "SZ Cancellation List" never drift apart.
  const groupedByStructure = useMemo(() => {
    const groups = aggregateLedgerEntries(filtered);
    const q = search.trim();
    if (!q) return groups;

    // When searching, sort the aggregated rows within each structure by search score
    // so prefix matches (e.g. names starting with "amo") appear at the top
    return groups.map((g) => {
      const scoreMap = new Map<string, number>();
      for (const row of g.rows) {
        const { score } = evaluateLedgerSearch(
          {
            name: row.name,
            structure: row.structure,
            notes: row.notes,
            formattedDateList: row.formattedDateList,
            serviceCodes: row.serviceCodes,
            repName: row.repName,
          },
          q
        );
        scoreMap.set(row.key, score);
      }

      const sortRows = (rows: AggregatedLedgerRow[]) =>
        [...rows].sort((a, b) => {
          const scoreA = scoreMap.get(a.key) ?? 0;
          const scoreB = scoreMap.get(b.key) ?? 0;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return b.amount - a.amount;
        });

      return {
        ...g,
        rows: sortRows(g.rows),
        cancellationRows: sortRows(g.cancellationRows),
        sponsorshipRows: sortRows(g.sponsorshipRows),
      };
    });
  }, [filtered, search]);

  async function handleImportFile(file: File) {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const result = parseHistoricalCancellationWorkbook(buf);
      if (result.rows.length > 0) {
        await importHistoricalCancellations(result.rows);
        const refreshed = await listLedgerEntries();
        setEntries(refreshed);
      }
      setImportResult(result);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  function onImportInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  }

  function toggleStructure(s: string) {
    setOpenStructures((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function expandAllStructures() {
    setOpenStructures(new Set(groupedByStructure.map((g) => g.structure)));
  }

  function collapseAllStructures() {
    setOpenStructures(new Set());
  }

  async function handleDeleteRow(row: AggregatedLedgerRow) {
    try {
      await Promise.all(row.entryIds.map((id) => deleteLedgerEntry(id)));
      const idSet = new Set(row.entryIds);
      setEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function openPaymentModal(row: AggregatedLedgerRow) {
    setPaymentTarget(row);
    setPaymentAmount(String(row.amount));
    setPaymentError(null);
  }

  function closePaymentModal() {
    setPaymentTarget(null);
    setPaymentAmount('');
    setPaymentError(null);
  }

  function openAddModal() {
    setAddFirstName('');
    setAddSurname('');
    setAddStructure(structureFilter || 'S1');
    setAddService('PM');
    setAddAmount('40');
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddNotes('');
    setAddIsSponsored(false);
    setAddError(null);
    setAddSuccessMessage(null);
    setShowAddModal(true);
  }

  function closeAddModal() {
    setShowAddModal(false);
    setAddError(null);
  }

  async function handleAddDebtor() {
    if (!addFirstName.trim()) {
      setAddError('First name is required.');
      return;
    }
    if (!addSurname.trim()) {
      setAddError('Surname is required.');
      return;
    }
    if (!addStructure.trim()) {
      setAddError('Structure is required.');
      return;
    }
    if (!addDate) {
      setAddError('Date is required.');
      return;
    }
    const amtNum = Number(addAmount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      setAddError('Please enter a valid positive amount.');
      return;
    }

    setAddingDebtor(true);
    setAddError(null);
    try {
      await addManualLedgerEntry({
        firstName: addFirstName,
        surname: addSurname,
        structure: addStructure,
        service: addService,
        amount: amtNum,
        date: addDate,
        notes: addNotes,
        isSponsored: addIsSponsored,
      });

      const refreshed = await listLedgerEntries();
      setEntries(refreshed);
      setAddSuccessMessage(`Added ${addFirstName.trim()} ${addSurname.trim()} (R${amtNum}) to ${addStructure.toUpperCase()}`);
      setTimeout(() => {
        closeAddModal();
      }, 900);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingDebtor(false);
    }
  }

  async function handleConfirmPayment() {
    if (!paymentTarget) return;
    const amountNum = Number(paymentAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPaymentError('Please enter a valid positive payment amount (e.g. 20, 40, 80).');
      return;
    }
    if (amountNum > paymentTarget.amount) {
      setPaymentError(`Amount cannot exceed the total outstanding debt of R${paymentTarget.amount}.`);
      return;
    }

    setPaying(true);
    setPaymentError(null);
    try {
      await recordPartialPayment(paymentTarget.entryIds, amountNum);
      const refreshed = await listLedgerEntries();
      setEntries(refreshed);
      closePaymentModal();
    } catch (e) {
      setPaymentError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header current="ledger" />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* Hero */}
        <div className="mb-6 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-card to-bg p-6 sm:p-8">
          <span className="badge bg-crimson-500/15 text-crimson-300">
            <BookOpen className="h-3 w-3" />
            Master Ledger
          </span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Cancellation Ledger
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Structure and rep, cancellation date, name, and amount owing — the complete record of transport
            cancellation debt across every session. Download official PDFs in structure format or export spreadsheets.
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-3 py-20">
            <Loader2 className="h-8 w-8 animate-spin text-crimson-400" />
            <p className="text-sm text-muted">Loading ledger…</p>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-4 text-sm text-crimson-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-card py-20 text-center">
            <XCircle className="h-10 w-10 text-line" />
            <p className="text-sm text-muted">No cancellations recorded yet.</p>
            <p className="text-xs text-muted">Absentees appear here once a transport rep submits attendance from the Rep Portal.</p>
          </div>
        ) : (
          <>
            {/* Summary + download */}
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid grid-cols-3 gap-3">
                <SummaryStat label="Total Entries" value={entries.length} />
                <SummaryStat label="Filtered" value={filtered.length} accent="crimson" />
                <SummaryStat label="Total Debt" value={`R${totalDebt}`} accent="warning" />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={openAddModal}
                  className="btn-primary flex items-center gap-2 shadow-sm"
                  title="Add a new debtor manually (Name, Surname, Structure, Service, Amount, Date)"
                >
                  <UserPlus className="h-4 w-4" />
                  <span>Add Debtor</span>
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={onImportInputChange}
                  className="hidden"
                />
                <button
                  onClick={() => importInputRef.current?.click()}
                  disabled={importing}
                  className="btn-ghost"
                  title="Bulk-import historical cancellation records (Structure, Date, Service, Passenger Name, Amount)"
                >
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Import History
                </button>
                <button
                  onClick={() => downloadCancellationDebtPdf(filtered.length > 0 ? filtered : entries)}
                  className="btn-crimson flex items-center gap-2 shadow-md hover:shadow-crimson"
                  title="Download official PDF report grouped by Structure and Person with CRC banking info"
                >
                  <FileText className="h-4 w-4" />
                  Download Debt PDF
                </button>
                <button
                  onClick={() => downloadLedgerExcel(filtered.length > 0 ? filtered : entries, `SZ_Cancellation_List_${new Date().toISOString().slice(0,10)}.xlsx`)}
                  className="btn-success flex items-center gap-2"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Excel Export
                </button>
              </div>
            </div>

            {/* Historical import feedback */}
            {importFileName && (importing || importResult || importError) && (
              <div className="mb-4 space-y-2 rounded-xl border border-line bg-card p-4 animate-fade-in">
                {importing ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="h-4 w-4 animate-spin text-crimson-400" />
                    Importing {importFileName}…
                  </div>
                ) : importError ? (
                  <div className="flex items-start gap-2 text-sm text-crimson-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {importError}
                  </div>
                ) : importResult ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-semibold text-success-light">
                      <CheckCircle2 className="h-4 w-4" />
                      Imported {importResult.imported} of {importResult.totalRows} row(s) from {importFileName}
                    </div>
                    {importResult.skipped > 0 && (
                      <p className="text-xs text-muted">{importResult.skipped} row(s) skipped — see details below.</p>
                    )}
                    {importResult.warnings.length > 0 && (
                      <div className="max-h-32 space-y-1 overflow-y-auto text-xs text-warning">
                        {importResult.warnings.map((w, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{w}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {/* Search + filter controls */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by first name, surname, or structure (e.g. 'amo', 'amo nhlabathi')…"
                  className="input-field pl-10 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink hover:bg-card-2"
                    title="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="relative sm:w-56">
                <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <select
                  value={structureFilter}
                  onChange={(e) => setStructureFilter(e.target.value)}
                  className="input-field pl-10"
                >
                  <option value="" className="bg-card-2">All Structures</option>
                  {structures.map((s) => (
                    <option key={s} value={s} className="bg-card-2">{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {search.trim() && (
              <div className="mb-3 flex items-center justify-between rounded-lg border border-crimson-500/30 bg-crimson-500/10 px-3 py-1.5 text-xs text-crimson-300">
                <span>
                  Filtering by: <strong>"{search.trim()}"</strong> · Found <strong>{filtered.length}</strong> debtor record{filtered.length === 1 ? '' : 's'} across <strong>{groupedByStructure.length}</strong> structure{groupedByStructure.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="text-xs font-semibold underline hover:text-crimson-200"
                >
                  Clear filter
                </button>
              </div>
            )}

            {/* Expand / Collapse All Controls */}
            <div className="mb-3 flex items-center justify-between px-1 text-xs text-muted">
              <span>
                {groupedByStructure.length} structure{groupedByStructure.length === 1 ? '' : 's'} · {search.trim() ? `${groupedByStructure.length} matching` : `${openStructures.size} open`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={expandAllStructures}
                  className="rounded-md border border-line/60 bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 transition-colors"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={collapseAllStructures}
                  className="rounded-md border border-line/60 bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 transition-colors"
                >
                  Collapse All
                </button>
              </div>
            </div>

            {/* Grouped by structure — strict alphanumeric order (S1, S2, S9, S13) */}
            <div className="space-y-4">
              {groupedByStructure.map(({ structure, rows, cancellationRows, sponsorshipRows, cancellationDebt, sponsorshipDebt, totalDebt: structDebt }) => {
                const isOpen = Boolean(search.trim()) || openStructures.has(structure);
                const structureLabel = structure === 'No Structure' ? structure : `Structure ${structure}`;

                return (
                  <div key={structure} className="overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
                    <button
                      onClick={() => toggleStructure(structure)}
                      className="flex w-full items-center justify-between gap-2 border-b border-line/60 bg-card-2/60 px-4 py-3.5 text-left transition-colors hover:bg-card-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {isOpen ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                        <span className="font-display text-sm font-bold text-ink">{structureLabel}</span>
                        <span className="badge bg-bg/60 text-muted text-[10px]">{rows.length} total</span>
                        {sponsorshipRows.length > 0 && (
                          <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px]">
                            {sponsorshipRows.length} sponsorship/unpaid
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 font-display text-sm font-bold">
                        <span className="text-crimson-400">R{structDebt}</span>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="space-y-4 p-3 sm:p-4">
                        {/* Section 1: Regular Cancellations */}
                        {cancellationRows.length > 0 && (
                          <div className="overflow-hidden rounded-xl border border-line/70 bg-bg/50">
                            <div className="flex items-center justify-between border-b border-line/60 bg-card-2/40 px-3 py-2">
                              <span className="text-xs font-bold uppercase tracking-wider text-ink/80">
                                Cancellations ({cancellationRows.length})
                              </span>
                              <span className="font-display text-xs font-bold text-crimson-400">
                                Subtotal: R{cancellationDebt}
                              </span>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-line/60 bg-card-2/30 text-muted">
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Date(s) & Service</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Passenger Name</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Amount Owing</th>
                                    <th className="px-3.5 py-2.5 text-right font-display text-xs font-bold uppercase tracking-wider">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-line/40">
                                  {cancellationRows.map((row) => (
                                    <tr key={row.key} className="transition-colors hover:bg-card-2/20">
                                      <td className="px-3.5 py-2.5 text-muted align-top">
                                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                                          {row.instances.map((ins, idx) => (
                                            <span
                                              key={idx}
                                              className="inline-flex items-center gap-1 rounded bg-card-2/80 px-2 py-0.5 text-xs text-ink font-mono border border-line/60"
                                            >
                                              <span>{ins.formatted}</span>
                                              <span className="text-[10px] text-crimson-400 font-sans font-semibold">R{ins.amount}</span>
                                            </span>
                                          ))}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-ink">
                                            <HighlightMatch text={row.name} query={search} />
                                          </span>
                                          {row.serviceCodes.map((code) => (
                                            <ServiceBadge key={code} code={code} />
                                          ))}
                                          {row.instances.some((i) => i.isFTV) && (
                                            <span className="inline-flex items-center rounded px-1.5 py-0.2 text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/25">
                                              FTV (R20)
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex items-center gap-1.5">
                                          <span className="font-display font-bold text-crimson-400 text-base">R{row.amount}</span>
                                          {row.instances.length > 1 && (
                                            <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                              {row.instances.length} missed
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-right align-top">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            onClick={() => openPaymentModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                                            title="Record a payment or partial settlement from this debtor"
                                          >
                                            <Banknote className="h-3.5 w-3.5" />
                                            <span>Record Payment</span>
                                          </button>
                                          <button
                                            onClick={() => handleDeleteRow(row)}
                                            className="rounded-md border border-crimson-500/20 bg-crimson-900/20 p-1.5 text-crimson-300 hover:bg-crimson-900/40"
                                            title="Delete entry"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Section 2: Unaccounted Sponsorships & Unpaid */}
                        {sponsorshipRows.length > 0 && (
                          <div className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5">
                            <div className="flex items-center justify-between border-b border-amber-500/25 bg-amber-500/10 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-amber-400"></span>
                                <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                                  Unaccounted Sponsorships & Unpaid Debt ({sponsorshipRows.length})
                                </span>
                              </div>
                              <span className="font-display text-xs font-bold text-amber-300">
                                Subtotal: R{sponsorshipDebt}
                              </span>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-amber-500/20 bg-amber-500/5 text-amber-200/70">
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Date(s) & Service</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Passenger Name</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Category / Note</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Amount Owing</th>
                                    <th className="px-3.5 py-2.5 text-right font-display text-xs font-bold uppercase tracking-wider">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-amber-500/15">
                                  {sponsorshipRows.map((row) => (
                                    <tr key={row.key} className="transition-colors hover:bg-amber-500/10">
                                      <td className="px-3.5 py-2.5 text-muted align-top">
                                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                                          {row.instances.map((ins, idx) => (
                                            <span
                                              key={idx}
                                              className="inline-flex items-center gap-1 rounded bg-card-2/80 px-2 py-0.5 text-xs text-ink font-mono border border-amber-500/30"
                                            >
                                              <span>{ins.formatted}</span>
                                              <span className="text-[10px] text-amber-300 font-sans font-semibold">R{ins.amount}</span>
                                            </span>
                                          ))}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-ink">
                                            <HighlightMatch text={row.name} query={search} />
                                          </span>
                                          {row.serviceCodes.map((code) => (
                                            <ServiceBadge key={code} code={code} />
                                          ))}
                                          {row.instances.some((i) => i.isFTV) && (
                                            <span className="inline-flex items-center rounded px-1.5 py-0.2 text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/25">
                                              FTV (R20)
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-200 border border-amber-500/30">
                                          {row.notes || 'Unaccounted Sponsorship'}
                                        </span>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex items-center gap-1.5">
                                          <span className="font-display font-bold text-amber-300 text-base">R{row.amount}</span>
                                          {row.instances.length > 1 && (
                                            <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                              {row.instances.length}x
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-right align-top">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            onClick={() => openPaymentModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                                            title="Record a payment or partial settlement from this debtor"
                                          >
                                            <Banknote className="h-3.5 w-3.5" />
                                            <span>Record Payment</span>
                                          </button>
                                          <button
                                            onClick={() => handleDeleteRow(row)}
                                            className="rounded-md border border-crimson-500/20 bg-crimson-900/20 p-1.5 text-crimson-300 hover:bg-crimson-900/40"
                                            title="Delete entry"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Payment Modal */}
            {paymentTarget && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in backdrop-blur-sm">
                <div className="w-full max-w-md rounded-2xl border border-line bg-card p-6 shadow-xl">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-emerald-500/15 p-2 text-emerald-400">
                        <Banknote className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-display text-lg font-bold text-ink">Record Payment</h3>
                        <p className="text-xs text-muted">Deduct full or partial amount from debt</p>
                      </div>
                    </div>
                    <button
                      onClick={closePaymentModal}
                      disabled={paying}
                      className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-4 space-y-4">
                    <div className="rounded-xl border border-line/60 bg-card-2/60 p-3.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted">Debtor:</span>
                        <span className="font-bold text-ink">{paymentTarget.name}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-muted">Structure:</span>
                        <span className="font-medium text-ink">{paymentTarget.structure}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-muted">Total Outstanding:</span>
                        <span className="font-display text-base font-bold text-crimson-400">R{paymentTarget.amount}</span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        Missed sessions: <span className="font-mono text-ink/90">{paymentTarget.formattedDateList}</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1.5">
                        Amount Paid (R)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-bold text-muted">R</span>
                        <input
                          type="number"
                          min="1"
                          max={paymentTarget.amount}
                          step="10"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          placeholder="e.g. 40"
                          className="input-field pl-8 font-mono text-lg font-bold text-ink"
                          autoFocus
                        />
                      </div>
                      {/* Quick preset chips */}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {paymentTarget.amount >= 20 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('20')}
                            className="rounded bg-card-2 px-2 py-0.5 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60"
                          >
                            R20 (FTV)
                          </button>
                        )}
                        {paymentTarget.amount >= 40 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('40')}
                            className="rounded bg-card-2 px-2 py-0.5 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60"
                          >
                            R40 (1 session)
                          </button>
                        )}
                        {paymentTarget.amount >= 80 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('80')}
                            className="rounded bg-card-2 px-2 py-0.5 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60"
                          >
                            R80 (2 sessions)
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPaymentAmount(String(paymentTarget.amount))}
                          className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 font-semibold"
                        >
                          Full Debt (R{paymentTarget.amount})
                        </button>
                      </div>
                    </div>

                    {paymentError && (
                      <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{paymentError}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
                      <button
                        type="button"
                        onClick={closePaymentModal}
                        disabled={paying}
                        className="btn-ghost text-xs"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmPayment}
                        disabled={paying || !paymentAmount}
                        className="btn-success flex items-center gap-2 text-xs"
                      >
                        {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                        Confirm Payment of R{paymentAmount || 0}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Manual Add Debtor Modal */}
            {showAddModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in backdrop-blur-sm">
                <div className="w-full max-w-lg rounded-2xl border border-line bg-card p-6 shadow-xl">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-crimson-500/15 p-2 text-crimson-400">
                        <UserPlus className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-display text-lg font-bold text-ink">Add Debtor to Ledger</h3>
                        <p className="text-xs text-muted">Directly record an absentee cancellation or debt</p>
                      </div>
                    </div>
                    <button
                      onClick={closeAddModal}
                      disabled={addingDebtor}
                      className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAddDebtor();
                    }}
                    className="mt-4 space-y-4"
                  >
                    {/* First Name & Surname */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          First Name <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={addFirstName}
                          onChange={(e) => setAddFirstName(e.target.value)}
                          placeholder="e.g. Amo"
                          className="input-field w-full text-sm"
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Surname <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={addSurname}
                          onChange={(e) => setAddSurname(e.target.value)}
                          placeholder="e.g. Nhlabathi"
                          className="input-field w-full text-sm"
                        />
                      </div>
                    </div>

                    {/* Structure & Service Type */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Structure <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={addStructure}
                          onChange={(e) => setAddStructure(e.target.value.toUpperCase())}
                          placeholder="e.g. S1, S2, S13, YZ1"
                          className="input-field w-full font-mono text-sm font-semibold uppercase"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Service Type <span className="text-crimson-400">*</span>
                        </label>
                        <select
                          value={addService}
                          onChange={(e) => setAddService(e.target.value)}
                          className="input-field w-full text-sm"
                        >
                          <option value="PM">PM (Evening Service)</option>
                          <option value="AM">AM (Morning Service)</option>
                          <option value="LM">LM (Leaders Meeting)</option>
                          <option value="WMP">WMP (Worship/Music/Prayer)</option>
                          <option value="EF">EF (Easter Friday)</option>
                          <option value="AD">AD (Ascension Day)</option>
                          <option value="FW">FW (Fast & Worship)</option>
                        </select>
                      </div>
                    </div>

                    {/* Amount & Date */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Amount Owing (R) <span className="text-crimson-400">*</span>
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-muted text-sm">R</span>
                          <input
                            type="number"
                            min="1"
                            step="10"
                            required
                            value={addAmount}
                            onChange={(e) => setAddAmount(e.target.value)}
                            className="input-field w-full pl-7 font-mono font-bold text-sm"
                          />
                        </div>
                        <div className="mt-1 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAddAmount('40')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R40 (Standard)
                          </button>
                          <span className="text-[10px] text-muted">·</span>
                          <button
                            type="button"
                            onClick={() => setAddAmount('20')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R20 (FTV)
                          </button>
                          <span className="text-[10px] text-muted">·</span>
                          <button
                            type="button"
                            onClick={() => setAddAmount('80')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R80 (2 trips)
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Date <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={addDate}
                          onChange={(e) => setAddDate(e.target.value)}
                          className="input-field w-full text-sm font-mono"
                        />
                      </div>
                    </div>

                    {/* Notes & Sponsorship Flag */}
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                        General Notes / FTV Indicator
                      </label>
                      <input
                        type="text"
                        value={addNotes}
                        onChange={(e) => setAddNotes(e.target.value)}
                        placeholder="e.g. FTV, Did not arrive at stop, Unaccounted"
                        className="input-field w-full text-xs"
                      />
                    </div>

                    <div className="flex items-center gap-2 rounded-lg bg-card-2/60 p-2.5 border border-line/60">
                      <input
                        type="checkbox"
                        id="isSponsoredCheckbox"
                        checked={addIsSponsored}
                        onChange={(e) => setAddIsSponsored(e.target.checked)}
                        className="rounded border-line bg-card text-crimson-500 focus:ring-crimson-500"
                      />
                      <label htmlFor="isSponsoredCheckbox" className="text-xs text-ink cursor-pointer select-none">
                        Mark as <span className="font-semibold text-amber-300">Unaccounted Sponsorship / Unpaid</span> (groups into structure sponsorship breakdown)
                      </label>
                    </div>

                    {addError && (
                      <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{addError}</span>
                      </div>
                    )}

                    {addSuccessMessage && (
                      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-xs text-emerald-300">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        <span>{addSuccessMessage}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
                      <button
                        type="button"
                        onClick={closeAddModal}
                        disabled={addingDebtor}
                        className="btn-ghost text-xs"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={addingDebtor}
                        className="btn-crimson flex items-center gap-2 text-xs font-semibold shadow-md"
                      >
                        {addingDebtor ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        Add to Ledger
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {filtered.length === 0 && search && (
              <div className="mt-4 text-center text-sm text-muted">
                No entries match your search. Try different keywords or clear the filter.
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string | number; accent?: 'crimson' | 'warning' }) {
  const color = accent === 'crimson' ? 'text-crimson-400' : accent === 'warning' ? 'text-warning' : 'text-ink';
  return (
    <div className="card flex items-center gap-3 p-3">
      <div>
        <div className={`font-display text-xl font-bold ${color}`}>{value}</div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      </div>
    </div>
  );
}

function ServiceBadge({ code }: { code: string }) {
  const c = code.toUpperCase();
  if (c === 'LM') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25" title="Leaders Meeting">
        LM
      </span>
    );
  }
  if (c === 'WMP') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25" title="Worship, Music & Prayer">
        WMP
      </span>
    );
  }
  if (c === 'EF') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/25" title="Easter Friday">
        EF
      </span>
    );
  }
  if (c === 'AD') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-500/15 text-orange-300 border border-orange-500/25" title="Ascension Day">
        AD
      </span>
    );
  }
  if (c === 'FW') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-violet-500/15 text-violet-300 border border-violet-500/25" title="Fast & Worship">
        FW
      </span>
    );
  }
  if (c === 'AM') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/25" title="Morning Service">
        AM
      </span>
    );
  }
  if (c === 'PM') {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/25" title="Evening Service">
        PM
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-zinc-500/15 text-zinc-300 border border-zinc-500/25">
      {code}
    </span>
  );
}

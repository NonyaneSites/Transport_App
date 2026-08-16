import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2, AlertTriangle, FileSpreadsheet, Search, Trash2, Filter, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import {
  listLedgerEntries, deleteLedgerEntry, downloadLedgerExcel,
  aggregateLedgerEntries, type LedgerEntry, type AggregatedLedgerRow,
} from '@/lib/ledger';
import { shortDate } from '@/lib/dates';
import { naturalCompare } from '@/lib/sort';

export function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [structureFilter, setStructureFilter] = useState('');
  const [collapsedStructures, setCollapsedStructures] = useState<Set<string>>(new Set());

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
    const q = search.toLowerCase().trim();
    return entries.filter((e) => {
      if (structureFilter && e.structure !== structureFilter) return false;
      if (!q) return true;
      return (
        e.passenger_name.toLowerCase().includes(q) ||
        e.structure.toLowerCase().includes(q) ||
        (e.rep_name || '').toLowerCase().includes(q)
      );
    });
  }, [entries, search, structureFilter]);

  const totalDebt = filtered.reduce((sum, e) => sum + Number(e.structure_debt), 0);

  // Shared with the download (see aggregateLedgerEntries in lib/ledger) so
  // the web view and the exported "SZ Cancellation List" never drift apart.
  const groupedByStructure = useMemo(() => aggregateLedgerEntries(filtered), [filtered]);

  function toggleStructure(s: string) {
    setCollapsedStructures((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
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
            cancellation debt across every session. Banking details and payment policy are on the downloadable
            SZ Cancellation List.
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
              <button
                onClick={() => downloadLedgerExcel(filtered.length > 0 ? filtered : entries, `SZ_Cancellation_List_${new Date().toISOString().slice(0,10)}.xlsx`)}
                className="btn-success"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Download Ledger
              </button>
            </div>

            {/* Search + filter controls */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, structure, or rep…"
                  className="input-field pl-10"
                />
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

            {/* Grouped by structure — strict alphanumeric order (S1, S2, S9, S13) */}
            <div className="space-y-3">
              {groupedByStructure.map(({ structure, reps, rows, totalDebt: structDebt }) => {
                const isCollapsed = collapsedStructures.has(structure);
                // Rep name(s) moved to the end of the structure label, e.g. "S1 - Nthabiseng, Nthabeleng"
                const structureLabel = reps.length > 0 ? `${structure} - ${reps.join(', ')}` : structure;
                return (
                  <div key={structure} className="overflow-hidden rounded-2xl border border-line bg-card">
                    <button
                      onClick={() => toggleStructure(structure)}
                      className="flex w-full items-center justify-between gap-2 border-b border-line/60 bg-card-2/40 px-4 py-3 text-left transition-colors hover:bg-card-2/70"
                    >
                      <div className="flex items-center gap-2">
                        {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
                        <span className="font-display text-sm font-bold text-ink">{structureLabel}</span>
                        <span className="badge bg-bg/60 text-muted text-[10px]">{rows.length}</span>
                      </div>
                      <span className="font-display text-sm font-bold text-crimson-400">R{structDebt}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-line bg-card-2/50">
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Structure and Rep</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Cancellation Date</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Name</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Amount Owing</th>
                              <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {rows.map((row) => (
                              <tr key={row.key} className="transition-colors hover:bg-card-2/30">
                                <td className="px-4 py-3 text-ink">{row.structure} - {row.repName}</td>
                                <td className="px-4 py-3 text-muted">{shortDate(row.latestDate)}</td>
                                <td className="px-4 py-3">
                                  <span className="font-semibold text-ink">{row.name}</span>
                                  <span className="text-muted"> ({row.service.split(' ')[0]})</span>
                                </td>
                                <td className="px-4 py-3">
                                  <span className="font-display font-bold text-crimson-400">R{row.amount}</span>
                                  {row.entryIds.length > 1 && (
                                    <span className="ml-1 text-[10px] text-muted">({row.entryIds.length}x)</span>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex items-center justify-end">
                                    <button onClick={() => handleDeleteRow(row)} className="rounded-md border border-crimson-500/20 bg-crimson-900/20 p-1.5 text-crimson-300 hover:bg-crimson-900/40" title="Delete">
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

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

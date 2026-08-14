import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2, AlertTriangle, FileSpreadsheet, Search, Trash2, Pencil, Check, X, Filter, Bus, Car, CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { listLedgerEntries, deleteLedgerEntry, updateLedgerEntry, downloadLedgerExcel, type LedgerEntry } from '@/lib/ledger';
import { prettyDate } from '@/lib/dates';
import { CANCELLATION_FEE } from '@/lib/types';

export function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [structureFilter, setStructureFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<LedgerEntry>>({});
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
    return Array.from(set).sort();
  }, [entries]);

  const submittedVehicles = useMemo(() => {
    const map = new Map<string, { name: string; rep: string; plate: string; service: string; date: string; count: number; hasLedger: boolean }>();
    for (const e of entries) {
      const key = `${e.vehicle_name}|${e.service}|${e.date}`;
      if (!map.has(key)) {
        map.set(key, {
          name: e.vehicle_name,
          rep: e.rep_name || e.submitted_by || '—',
          plate: e.license_plate || '—',
          service: e.service,
          date: e.date,
          count: 0,
          hasLedger: true,
        });
      }
      map.get(key)!.count++;
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return entries.filter((e) => {
      if (structureFilter && e.structure !== structureFilter) return false;
      if (!q) return true;
      return (
        e.passenger_name.toLowerCase().includes(q) ||
        e.structure.toLowerCase().includes(q) ||
        e.stop.toLowerCase().includes(q) ||
        e.vehicle_name.toLowerCase().includes(q) ||
        e.service.toLowerCase().includes(q) ||
        (e.rep_name || '').toLowerCase().includes(q) ||
        (e.sponsor_note || '').toLowerCase().includes(q)
      );
    });
  }, [entries, search, structureFilter]);

  const totalDebt = filtered.reduce((sum, e) => sum + Number(e.structure_debt), 0);

  const groupedByStructure = useMemo(() => {
    const map = new Map<string, LedgerEntry[]>();
    for (const e of filtered) {
      const key = e.structure || 'No Structure';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  function toggleStructure(s: string) {
    setCollapsedStructures((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function handleDelete(id: string) {
    try {
      await deleteLedgerEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startEdit(entry: LedgerEntry) {
    setEditingId(entry.id);
    setEditValues({
      passenger_name: entry.passenger_name,
      structure: entry.structure,
      stop: entry.stop,
      structure_debt: entry.structure_debt,
      sponsored: entry.sponsored,
      sponsor_note: entry.sponsor_note,
      rep_name: entry.rep_name,
    });
  }

  async function saveEdit(id: string) {
    try {
      await updateLedgerEntry(id, editValues);
      setEntries((prev) => prev.map((e) => e.id === id ? { ...e, ...editValues } : e));
      setEditingId(null);
      setEditValues({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValues({});
  }

  return (
    <div className="min-h-screen">
      <Header current="ledger" />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* Hero */}
        <div className="mb-8 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-card to-bg p-6 sm:p-8">
          <span className="badge bg-crimson-500/15 text-crimson-300">
            <BookOpen className="h-3 w-3" />
            Master Ledger
          </span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Cancellation Ledger
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Complete record of all absentees across every transport session. Search, filter by structure,
            edit or remove entries, and download the full ledger for accountability.
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
                onClick={() => downloadLedgerExcel(filtered.length > 0 ? filtered : entries, `cancellation_ledger_${new Date().toISOString().slice(0,10)}.xlsx`)}
                className="btn-success"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Download Ledger
              </button>
            </div>

            {/* Submitted vehicles — accountability */}
            {submittedVehicles.length > 0 && (
              <div className="mb-6 card">
                <div className="mb-3 flex items-center gap-2">
                  <div className="h-5 w-1 rounded-full bg-success" />
                  <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Submitted Vehicles</h2>
                  <span className="badge bg-success/15 text-success-light">{submittedVehicles.length}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {submittedVehicles.map((v, i) => {
                    const Icon = v.name.toLowerCase().includes('taxi') ? Car : Bus;
                    return (
                      <div key={i} className="rounded-xl border border-line bg-card-2 p-3">
                        <div className="flex items-center gap-2">
                          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                            v.name.toLowerCase().includes('taxi') ? 'bg-success/15 text-success-light' : 'bg-crimson-500/15 text-crimson-400'
                          }`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-ink">{v.name}</div>
                            <div className="text-[10px] text-muted">{v.service}</div>
                          </div>
                        </div>
                        <div className="mt-2 space-y-0.5 text-xs text-muted">
                          <div><span className="font-semibold text-ink">Rep:</span> {v.rep}</div>
                          <div><span className="font-semibold text-ink">Plate:</span> {v.plate}</div>
                          <div><span className="font-semibold text-ink">Date:</span> {prettyDate(v.date)}</div>
                          <div><span className="font-semibold text-ink">Absentees:</span> <span className="text-crimson-300">{v.count}</span></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
                  placeholder="Search by name, structure, stop, vehicle, rep, or notes…"
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

            {/* Grouped by structure */}
            <div className="space-y-3">
              {groupedByStructure.map(([structure, structEntries]) => {
                const isCollapsed = collapsedStructures.has(structure);
                const structDebt = structEntries.reduce((sum, e) => sum + Number(e.structure_debt), 0);
                return (
                  <div key={structure} className="overflow-hidden rounded-2xl border border-line bg-card">
                    <button
                      onClick={() => toggleStructure(structure)}
                      className="flex w-full items-center justify-between gap-2 border-b border-line/60 bg-card-2/40 px-4 py-3 text-left transition-colors hover:bg-card-2/70"
                    >
                      <div className="flex items-center gap-2">
                        {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
                        <span className="font-display text-sm font-bold text-ink">{structure}</span>
                        <span className="badge bg-bg/60 text-muted text-[10px]">{structEntries.length}</span>
                      </div>
                      <span className="font-display text-sm font-bold text-crimson-400">R{structDebt}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-line bg-card-2/50">
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Passenger</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Stop</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Service & Date</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Sponsored</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Sponsor Note</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">General Notes</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Debt (R)</th>
                              <th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Rep / Plate</th>
                              <th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {structEntries.map((e) => {
                              const isEditing = editingId === e.id;
                              return (
                                <tr key={e.id} className="transition-colors hover:bg-card-2/30">
                                  <td className="px-4 py-3">
                                    {isEditing ? (
                                      <input type="text" value={editValues.passenger_name ?? ''} onChange={(ev) => setEditValues({ ...editValues, passenger_name: ev.target.value })} className="input-field py-1 text-sm" />
                                    ) : (
                                      <span className="font-semibold text-ink">{e.passenger_name}</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    {isEditing ? (
                                      <input type="text" value={editValues.stop ?? ''} onChange={(ev) => setEditValues({ ...editValues, stop: ev.target.value })} className="input-field py-1 text-sm w-32" />
                                    ) : (
                                      <span className="text-muted">{e.stop}</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="text-xs text-muted">{e.service}</div>
                                    <div className="text-xs text-muted">{prettyDate(e.date)}</div>
                                  </td>
                                  <td className="px-4 py-3">
                                    {isEditing ? (
                                      <input type="checkbox" checked={editValues.sponsored ?? false} onChange={(ev) => setEditValues({ ...editValues, sponsored: ev.target.checked })} className="h-4 w-4" />
                                    ) : e.sponsored ? (
                                      <span className="badge bg-warning/15 text-warning text-[10px]">Yes</span>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 max-w-xs">
                                    {isEditing ? (
                                      <input type="text" value={editValues.sponsor_note ?? ''} onChange={(ev) => setEditValues({ ...editValues, sponsor_note: ev.target.value })} placeholder="Who is paying?" className="input-field py-1 text-sm" />
                                    ) : e.sponsor_note ? (
                                      <span className="text-xs text-muted truncate block max-w-xs">{e.sponsor_note}</span>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 max-w-xs">
                                    {e.general_notes ? (
                                      <span className="text-xs text-muted truncate block max-w-xs">{e.general_notes}</span>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    {isEditing ? (
                                      <input type="number" value={editValues.structure_debt ?? CANCELLATION_FEE} onChange={(ev) => setEditValues({ ...editValues, structure_debt: Number(ev.target.value) })} className="input-field py-1 text-sm w-20" />
                                    ) : (
                                      <span className="font-display font-bold text-crimson-400">R{e.structure_debt}</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="text-xs text-muted">{e.rep_name || e.submitted_by || '—'}</div>
                                    <div className="text-[10px] text-muted">{e.license_plate || '—'}</div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center justify-end gap-1.5">
                                      {isEditing ? (
                                        <>
                                          <button onClick={() => saveEdit(e.id)} className="rounded-md border border-success/30 bg-success/10 p-1.5 text-success-light hover:bg-success/20" title="Save">
                                            <Check className="h-3.5 w-3.5" />
                                          </button>
                                          <button onClick={cancelEdit} className="rounded-md border border-line bg-card-2 p-1.5 text-muted hover:text-ink" title="Cancel">
                                            <X className="h-3.5 w-3.5" />
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button onClick={() => startEdit(e)} className="rounded-md border border-line bg-card-2 p-1.5 text-muted hover:text-crimson-300 hover:border-crimson-500/30" title="Edit">
                                            <Pencil className="h-3.5 w-3.5" />
                                          </button>
                                          <button onClick={() => handleDelete(e.id)} className="rounded-md border border-crimson-500/20 bg-crimson-900/20 p-1.5 text-crimson-300 hover:bg-crimson-900/40" title="Delete">
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
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

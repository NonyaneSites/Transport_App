import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2, AlertTriangle, FileSpreadsheet, Search, Trash2, Pencil, Check, X, Filter, XCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { listLedgerEntries, deleteLedgerEntry, updateLedgerEntry, downloadLedgerExcel, type LedgerEntry } from '@/lib/ledger';
import { CANCELLATION_FEE } from '@/lib/types';

function structureSort(a: string, b: string) {
  const ma = a.match(/^(S)(\d+)/i), mb = b.match(/^(S)(\d+)/i);
  if (ma && mb) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function officialDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [structureFilter, setStructureFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<LedgerEntry>>({});

  useEffect(() => {
    let mounted = true;
    (async () => { try { const data = await listLedgerEntries(); if (mounted) { setEntries(data); setLoading(false); } } catch (e) { if (mounted) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } } })();
    return () => { mounted = false; };
  }, []);

  const structures = useMemo(() => [...new Set(entries.map((e) => e.structure).filter(Boolean))].sort(structureSort), [entries]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return entries.filter((e) => {
      if (structureFilter && e.structure !== structureFilter) return false;
      if (!q) return true;
      const rep = e.rep_name || e.submitted_by || '';
      return e.passenger_name.toLowerCase().includes(q) || e.structure.toLowerCase().includes(q) || rep.toLowerCase().includes(q);
    }).sort((a, b) => structureSort(a.structure, b.structure) || a.passenger_name.localeCompare(b.passenger_name, undefined, { sensitivity: 'base' }) || officialDate(a.date).localeCompare(officialDate(b.date)));
  }, [entries, search, structureFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, LedgerEntry[]>();
    filtered.forEach((e) => { const key = e.structure || 'No Structure'; const list = map.get(key) ?? []; list.push(e); map.set(key, list); });
    return [...map.entries()].sort((a, b) => structureSort(a[0], b[0]));
  }, [filtered]);

  const totalDebt = filtered.reduce((sum, e) => sum + Number(e.structure_debt), 0);

  async function handleDelete(id: string) { try { await deleteLedgerEntry(id); setEntries((prev) => prev.filter((e) => e.id !== id)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }
  function startEdit(e: LedgerEntry) { setEditingId(e.id); setEditValues({ passenger_name: e.passenger_name, structure: e.structure, structure_debt: e.structure_debt, rep_name: e.rep_name }); }
  async function saveEdit(id: string) { try { await updateLedgerEntry(id, editValues); setEntries((prev) => prev.map((e) => e.id === id ? { ...e, ...editValues } as LedgerEntry : e)); setEditingId(null); setEditValues({}); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }

  return <div className="min-h-screen"><Header current="ledger"/><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <div className="mb-8 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-card to-bg p-6 sm:p-8"><span className="badge bg-crimson-500/15 text-crimson-300"><BookOpen className="h-3 w-3"/>Master Ledger</span><h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink">Cancellation Ledger</h1><p className="mt-2 max-w-2xl text-sm text-muted">Official four-column cancellation view. Operational vehicle, plate, sponsorship, and notes data stays in the Admin Session Archive.</p></div>
    {loading ? <div className="flex flex-col items-center gap-3 py-20"><Loader2 className="h-8 w-8 animate-spin text-crimson-400"/>Loading ledger…</div> : error ? <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-4 text-sm text-crimson-300"><AlertTriangle className="h-4 w-4"/>{error}</div> : entries.length === 0 ? <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-card py-20 text-center"><XCircle className="h-10 w-10 text-line"/><p className="text-sm text-muted">No cancellations recorded yet.</p></div> : <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="grid grid-cols-3 gap-3"><div className="card p-3"><div className="font-display text-xl font-bold text-ink">{entries.length}</div><div className="text-[10px] uppercase tracking-wide text-muted">Total Entries</div></div><div className="card p-3"><div className="font-display text-xl font-bold text-crimson-400">{filtered.length}</div><div className="text-[10px] uppercase tracking-wide text-muted">Filtered</div></div><div className="card p-3"><div className="font-display text-xl font-bold text-warning">R{totalDebt}</div><div className="text-[10px] uppercase tracking-wide text-muted">Amount Owing</div></div></div><button onClick={() => downloadLedgerExcel(filtered.length ? filtered : entries, `Transport_Ministry_2026_Cancellation_List_${new Date().toISOString().slice(0,10)}.xlsx`)} className="btn-success"><FileSpreadsheet className="h-4 w-4"/>Download Official Excel</button></div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, structure, or rep…" className="input-field pl-10"/></div><div className="relative sm:w-56"><Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"/><select value={structureFilter} onChange={(e) => setStructureFilter(e.target.value)} className="input-field pl-10"><option value="">All Structures</option>{structures.map((s) => <option key={s} value={s}>{s}</option>)}</select></div></div>
      <div className="overflow-hidden rounded-2xl border border-line bg-card"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-line bg-card-2/50"><th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Structure and Rep</th><th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Cancellation Date</th><th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Name</th><th className="px-4 py-3 font-display text-xs font-bold uppercase tracking-wider text-muted">Amount Owing</th><th className="px-4 py-3 text-right font-display text-xs font-bold uppercase tracking-wider text-muted">Actions</th></tr></thead><tbody className="divide-y divide-line/60">{groups.flatMap(([structure, rows]) => rows.map((e, idx) => { const isEditing = editingId === e.id; const rep = e.rep_name || e.submitted_by || '—'; return <tr key={e.id} className="hover:bg-card-2/30"><td className="px-4 py-3">{idx === 0 ? <span className="font-semibold text-ink">{structure} - {rep}</span> : <span className="text-muted">{structure}</span>}</td><td className="px-4 py-3">{officialDate(e.date)}</td><td className="px-4 py-3">{isEditing ? <input value={editValues.passenger_name ?? ''} onChange={(ev) => setEditValues({ ...editValues, passenger_name: ev.target.value })} className="input-field py-1 text-sm"/> : <span className="font-semibold text-ink">{e.passenger_name}</span>}</td><td className="px-4 py-3">{isEditing ? <input type="number" value={editValues.structure_debt ?? CANCELLATION_FEE} onChange={(ev) => setEditValues({ ...editValues, structure_debt: Number(ev.target.value) })} className="input-field w-24 py-1 text-sm"/> : <span className="font-display font-bold text-crimson-400">R{e.structure_debt}</span>}</td><td className="px-4 py-3"><div className="flex justify-end gap-1.5">{isEditing ? <><button onClick={() => void saveEdit(e.id)} className="rounded-md border border-success/30 bg-success/10 p-1.5 text-success-light"><Check className="h-3.5 w-3.5"/></button><button onClick={() => { setEditingId(null); setEditValues({}); }} className="rounded-md border border-line p-1.5 text-muted"><X className="h-3.5 w-3.5"/></button></> : <><button onClick={() => startEdit(e)} className="rounded-md border border-line p-1.5 text-muted"><Pencil className="h-3.5 w-3.5"/></button><button onClick={() => void handleDelete(e.id)} className="rounded-md border border-crimson-500/20 bg-crimson-900/20 p-1.5 text-crimson-300"><Trash2 className="h-3.5 w-3.5"/></button></>}</div></td></tr>;}))}</tbody></table></div></div>
      <div className="mt-8 rounded-xl border border-line bg-card p-4 text-xs text-muted"><div className="font-semibold text-ink">Transport Ministry 2026 banking reference</div><div className="mt-1">ABSA · CRCY&amp;SJHB · Acc: 4100565706</div><div className="mt-1">The supplied page source did not contain the full official policy-rule wording, so it should be injected into the shared export function before issuing the final PDF/Excel template.</div></div>
    </>}
  </main><Footer/></div>;
}

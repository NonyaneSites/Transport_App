import { useEffect, useMemo, useState } from 'react';
import {
  Lock, Trash2, Loader2, AlertTriangle, Calendar, Users, Bus, ArrowUpRight, XCircle,
  FileSpreadsheet, ChevronDown, ChevronRight, History, ArrowUp, ArrowDown, Plus,
  MinusCircle, Copy, Check, UserRoundPlus,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { ExcelUpload } from '@/components/ExcelUpload';
import { useManifest } from '@/lib/useManifest';
import { listAllManifests } from '@/lib/manifest';
import { listLedgerEntries, downloadSessionStatsExcel } from '@/lib/ledger';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey } from '@/lib/dates';
import { SERVICE_TYPES, RESET_PASSWORD, type ServiceType, type Passenger, type Manifest } from '@/lib/types';
import type { ParseResult } from '@/lib/parser';
import { masterHubForStop, sanitizePassengerRecord, sanitizeTransportValue, MASTER_HUBS } from './transportSanitization';

type VehicleRecord = {
  id: string;
  name: string;
  type: string;
  capacity?: number;
  passengerIds?: string[];
  orderedStops?: string[];
  repName?: string;
  coReps?: string[];
  submitted?: boolean;
  submittedAt?: string;
  submittedBy?: string;
  licensePlate?: string;
  generalNotes?: string;
};

function vehicleRecord(v: any): VehicleRecord {
  return v as VehicleRecord;
}

function idsForVehicle(v: any): string[] {
  const x = vehicleRecord(v);
  if (Array.isArray(x.passengerIds)) return x.passengerIds;
  if (Array.isArray((x as any).riderIds)) return (x as any).riderIds;
  if (Array.isArray((x as any).passengers)) return (x as any).passengers;
  return [];
}

function normalizeVehicle(v: any): VehicleRecord {
  const x = vehicleRecord(v);
  return {
    ...x,
    passengerIds: idsForVehicle(x),
    orderedStops: Array.isArray(x.orderedStops) ? x.orderedStops : [],
    coReps: Array.isArray(x.coReps) ? x.coReps : [],
  };
}

function unallocatedByHub(manifest: Manifest) {
  const assigned = new Set<string>();
  manifest.vehicles.forEach((v: any) => idsForVehicle(v).forEach((id) => assigned.add(id)));
  const map = new Map<string, Passenger[]>();
  manifest.signups.forEach((raw) => {
    const p = sanitizePassengerRecord(raw as any) as Passenger;
    if (assigned.has(p.id)) return;
    const hub = masterHubForStop(p.stop);
    const list = map.get(hub) ?? [];
    list.push(p);
    map.set(hub, list);
  });
  return map;
}

export function AdminPage() {
  const [date, setDate] = useState(upcomingSunday);
  const [service, setService] = useState<ServiceType>('AM_Serving');
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetPwd, setResetPwd] = useState('');
  const [resetErr, setResetErr] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sessionList, setSessionList] = useState<Manifest[]>([]);
  const [ledgerCount, setLedgerCount] = useState(0);
  const [archiveSelected, setArchiveSelected] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [newVehicleType, setNewVehicleType] = useState<'Taxi' | 'Bus'>('Taxi');
  const [newCapacity, setNewCapacity] = useState(15);
  const [activeHubByVehicle, setActiveHubByVehicle] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [mans, ledger] = await Promise.all([listAllManifests(), listLedgerEntries()]);
        setSessionList(mans);
        setLedgerCount(ledger.length);
      } catch { /* non-critical */ }
    })();
  }, [manifest?.updated_at]);

  async function handleImport(passengers: Passenger[], _result: ParseResult) {
    const sanitized = passengers.map((p) => sanitizePassengerRecord(p as any) as Passenger);
    if (!manifest) {
      await save({ date: key, signups: sanitized, vehicles: [] });
      return;
    }
    const existingIds = new Set(manifest.signups.map((p) => p.id));
    const fresh = sanitized.filter((p) => !existingIds.has(p.id));
    await save({ ...manifest, signups: [...manifest.signups, ...fresh] });
  }

  async function handleReset() {
    if (resetPwd !== RESET_PASSWORD) { setResetErr(true); return; }
    setResetting(true);
    try {
      await save({ date: key, signups: [], vehicles: [] });
      setResetOpen(false); setResetPwd(''); setResetErr(false);
    } finally { setResetting(false); }
  }

  const serviceLabel = SERVICE_TYPES.find((s) => s.value === service)?.label ?? service;
  const activeManifest = manifest ?? { date: key, signups: [], vehicles: [] };
  const hubPools = useMemo(() => unallocatedByHub(activeManifest as Manifest), [activeManifest]);

  async function addVehicle() {
    const index = activeManifest.vehicles.length + 1;
    const vehicle: VehicleRecord = {
      id: crypto.randomUUID(),
      name: `${newVehicleType} ${index}`,
      type: newVehicleType,
      capacity: Math.max(1, Number(newCapacity) || 15),
      passengerIds: [], orderedStops: [], coReps: [],
    };
    await save({ ...activeManifest, vehicles: [...activeManifest.vehicles, vehicle as any] });
  }

  async function updateVehicle(vehicleId: string, updater: (v: VehicleRecord) => VehicleRecord) {
    const vehicles = activeManifest.vehicles.map((raw) => {
      const v = normalizeVehicle(raw);
      return v.id === vehicleId ? updater(v) : v;
    });
    await save({ ...activeManifest, vehicles: vehicles as any[] });
  }

  async function togglePassenger(vehicle: VehicleRecord, passenger: Passenger) {
    const selected = new Set(vehicle.passengerIds ?? []);
    const hub = masterHubForStop(passenger.stop);
    const wasAssigned = selected.has(passenger.id);
    if (wasAssigned) selected.delete(passenger.id); else {
      if (vehicle.capacity && selected.size >= vehicle.capacity) return;
      selected.add(passenger.id);
    }
    const orderedStops = [...(vehicle.orderedStops ?? [])];
    if (!wasAssigned && !orderedStops.includes(hub)) orderedStops.push(hub);
    if (wasAssigned) {
      const stillUsesHub = [...selected].some((id) => activeManifest.signups.find((p) => p.id === id && masterHubForStop(p.stop) === hub));
      if (!stillUsesHub) {
        // Preserve chronological insertion unless the hub is no longer represented.
        const i = orderedStops.indexOf(hub); if (i >= 0) orderedStops.splice(i, 1);
      }
    }
    await updateVehicle(vehicle.id, (v) => ({ ...v, passengerIds: [...selected], orderedStops }));
  }

  function moveStop(vehicle: VehicleRecord, index: number, delta: number) {
    const next = [...(vehicle.orderedStops ?? [])];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void updateVehicle(vehicle.id, (v) => ({ ...v, orderedStops: next }));
  }

  const manifestText = useMemo(() => {
    const byId = new Map(activeManifest.signups.map((p) => [p.id, p]));
    const lines: string[] = [`${serviceLabel} Taxis`, prettyDate(date), ''];
    activeManifest.vehicles.forEach((raw, idx) => {
      const v = normalizeVehicle(raw);
      lines.push(v.name || `Taxi ${idx + 1}`);
      let n = 1;
      for (const hub of v.orderedStops ?? []) {
        const riders = (v.passengerIds ?? []).map((id) => byId.get(id)).filter(Boolean).filter((p) => masterHubForStop(p!.stop) === hub) as Passenger[];
        if (!riders.length) continue;
        lines.push(`🛑 ${hub} (${riders.length})`);
        riders.forEach((p) => {
          const suffix = v.repName && p.fullName === v.repName ? `*${p.fullName}*` : p.fullName;
          lines.push(`    ${n}. ${suffix}`); n += 1;
        });
      }
      lines.push('');
    });
    return lines.join('\n').trimEnd();
  }, [activeManifest, serviceLabel, date]);

  async function copyManifest() {
    await navigator.clipboard.writeText(manifestText);
    setCopied(true); window.setTimeout(() => setCopied(false), 1400);
  }

  const totalRegistrations = sessionList.reduce((sum, m) => sum + m.signups.length, 0);
  const totalVehicles = sessionList.reduce((sum, m) => sum + m.vehicles.length, 0);
  const totalPresent = sessionList.reduce((sum, m) => sum + m.signups.filter((p) => p.present).length, 0);

  return (
    <div className="min-h-screen">
      <Header current="admin" />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="mb-8 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-card to-bg p-6 sm:p-8">
          <span className="badge bg-crimson-500/15 text-crimson-300"><span className="h-1.5 w-1.5 rounded-full bg-crimson-500 animate-pulse-dot" />Admin Dispatch Portal</span>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">Transport Dispatch Control</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">Upload Forms exports, allocate passengers by master hub, freeze the route order, and issue the live WhatsApp manifest.</p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <ServiceDateSelector date={date} service={service} onDateChange={setDate} onServiceChange={setService} />
          <ExcelUpload date={date} service={service} onImport={handleImport} existingCount={activeManifest.signups.length} />
        </div>

        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-crimson-500/20 bg-crimson-900/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div><div className="text-xs font-semibold uppercase tracking-wide text-muted">Active Session</div><div className="font-display text-lg font-bold text-ink">{prettyDate(date)} · {serviceLabel}</div></div>
          <div className="flex gap-2"><button onClick={copyManifest} className="btn-success"><Copy className="h-4 w-4" />{copied ? 'Copied' : 'Copy WhatsApp Manifest'}</button><button onClick={() => setResetOpen(true)} className="btn-danger"><Trash2 className="h-4 w-4" />Reset</button></div>
        </div>

        {error && <div className="mt-5 flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-3 text-sm text-crimson-300"><AlertTriangle className="h-4 w-4" />{error}</div>}

        {loading ? <div className="mt-8 flex flex-col items-center gap-3 py-16"><Loader2 className="h-8 w-8 animate-spin text-crimson-400" /><p className="text-sm text-muted">Loading manifest from cloud...</p></div> : (
          <div className="mt-5 space-y-5">
            <div className="card">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div><h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Vehicle Dispatch</h2><p className="mt-1 text-xs text-muted">Choose passengers by hub. Hub counts fall instantly as assignments are made.</p></div>
                <div className="flex items-end gap-2"><select value={newVehicleType} onChange={(e) => setNewVehicleType(e.target.value as 'Taxi' | 'Bus')} className="input-field"><option>Taxi</option><option>Bus</option></select><input type="number" min={1} value={newCapacity} onChange={(e) => setNewCapacity(Number(e.target.value))} className="input-field w-24"/><button onClick={addVehicle} className="btn-crimson"><Plus className="h-4 w-4"/>Add</button></div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from(hubPools.entries()).filter(([, ps]) => ps.length > 0).map(([hub, ps]) => <div key={hub} className="rounded-lg border border-line bg-card-2 px-3 py-2 text-sm"><span className="font-semibold text-ink">{hub}</span> <span className="text-muted">({ps.length} remaining)</span></div>)}
                {Array.from(hubPools.entries()).every(([, ps]) => ps.length === 0) && <div className="text-sm text-muted">All registered passengers are allocated.</div>}
              </div>
            </div>

            {activeManifest.vehicles.map((raw, index) => {
              const v = normalizeVehicle(raw);
              const assigned = new Set(v.passengerIds ?? []);
              const selectedHub = activeHubByVehicle[v.id] || (Array.from(hubPools.keys())[0] ?? '');
              const pool = (hubPools.get(selectedHub) ?? []).filter((p) => !assigned.has(p.id));
              return (
                <div key={v.id} className="rounded-2xl border border-line bg-card p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div><div className="font-display text-lg font-bold text-ink">{v.name}</div><div className="text-xs text-muted">{v.type} · {assigned.size}/{v.capacity ?? '∞'} passengers</div></div>
                    <div className="flex flex-wrap gap-2"><input value={v.repName ?? ''} onChange={(e) => void updateVehicle(v.id, (x) => ({ ...x, repName: sanitizeTransportValue(e.target.value) }))} placeholder="Assigned Rep" className="input-field w-48"/><input value={v.licensePlate ?? ''} onChange={(e) => void updateVehicle(v.id, (x) => ({ ...x, licensePlate: sanitizeTransportValue(e.target.value).toUpperCase() }))} placeholder="Plate" className="input-field w-32"/></div>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.5fr]">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Add passengers from hub</label>
                      <select value={selectedHub} onChange={(e) => setActiveHubByVehicle((s) => ({ ...s, [v.id]: e.target.value }))} className="input-field">
                        <option value="">Choose hub…</option>
                        {Array.from(hubPools.entries()).filter(([, ps]) => ps.length > 0).map(([h, ps]) => <option key={h} value={h}>{h} ({ps.length} remaining)</option>)}
                      </select>
                      <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-line">
                        {pool.map((p) => <button key={p.id} onClick={() => void togglePassenger(v, p)} className="flex w-full items-center justify-between border-b border-line/60 px-3 py-2 text-left text-sm hover:bg-card-2/60"><span className="text-ink">{p.fullName}</span><UserRoundPlus className="h-4 w-4 text-muted"/></button>)}
                        {selectedHub && !pool.length && <div className="p-3 text-xs text-muted">No unallocated passengers remain in {selectedHub}.</div>}
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 flex items-center justify-between"><label className="text-xs font-semibold uppercase tracking-wide text-muted">Frozen route order</label><span className="text-xs text-muted">Insert order is preserved</span></div>
                      <div className="space-y-2">
                        {(v.orderedStops ?? []).map((hub, i) => <div key={`${hub}-${i}`} className="flex items-center gap-2 rounded-xl border border-line bg-card-2 p-2.5"><span className="w-5 text-center text-xs font-bold text-muted">{i + 1}</span><span className="flex-1 text-sm font-semibold text-ink">🛑 {hub}</span><button onClick={() => moveStop(v, i, -1)} disabled={i === 0} className="rounded p-1 text-muted disabled:opacity-30"><ArrowUp className="h-4 w-4"/></button><button onClick={() => moveStop(v, i, 1)} disabled={i === (v.orderedStops?.length ?? 1) - 1} className="rounded p-1 text-muted disabled:opacity-30"><ArrowDown className="h-4 w-4"/></button></div>)}
                        {!v.orderedStops?.length && <div className="rounded-xl border border-dashed border-line p-4 text-xs text-muted">Add passengers from hubs to establish the route sequence.</div>}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2"><span className="badge bg-card-2 text-muted">{assigned.size} assigned</span>{(v.orderedStops ?? []).map((hub) => <span key={hub} className="badge bg-crimson-500/10 text-crimson-300">{hub}</span>)}</div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-card">
          <button onClick={() => setShowHistory(!showHistory)} className="flex w-full items-center justify-between p-4 text-left hover:bg-card-2/40"><div className="flex items-center gap-2"><History className="h-4 w-4 text-muted"/><h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Session Archive</h2><span className="badge bg-card-2 text-muted">{sessionList.length} sessions</span><span className="badge bg-crimson-500/15 text-crimson-300">{ledgerCount} ledger entries</span></div>{showHistory ? <ChevronDown className="h-5 w-5 text-muted"/> : <ChevronRight className="h-5 w-5 text-muted"/>}</button>
          {showHistory && <div className="border-t border-line p-4"><div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><AdminStat label="Sessions" value={sessionList.length}/><AdminStat label="Total Registered" value={totalRegistrations}/><AdminStat label="Vehicles" value={totalVehicles}/><AdminStat label="Present" value={totalPresent} accent="success"/></div><div className="flex gap-3"><select value={archiveSelected} onChange={(e) => setArchiveSelected(e.target.value)} className="input-field flex-1"><option value="">Select session…</option>{sessionList.map((m) => { const x = parseManifestKey(m.date); const def = SERVICE_TYPES.find((s) => s.value === x.service); return <option key={m.date} value={m.date}>{prettyDate(x.date)} · {def?.label ?? x.service}</option>; })}</select><button disabled={!archiveSelected} onClick={() => { const m = sessionList.find((s) => s.date === archiveSelected); if (!m) return; const lookup = (id: string) => m.signups.find((p) => p.id === id); const x = parseManifestKey(m.date); downloadSessionStatsExcel(m.vehicles, lookup, `session_stats_${x.date}.xlsx`); }} className="btn-success"><FileSpreadsheet className="h-4 w-4"/>Stats</button></div></div>}
        </div>
      </main>

      {resetOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setResetOpen(false)}><div className="w-full max-w-sm rounded-2xl border border-line bg-card p-6" onClick={(e) => e.stopPropagation()}><h3 className="font-display text-base font-bold text-ink">Reset Manifests</h3><p className="mt-1 text-xs text-muted">Clears vehicles and assignments for this session.</p><input type="password" value={resetPwd} onChange={(e) => { setResetPwd(e.target.value); setResetErr(false); }} className="input-field mt-4" placeholder="Reset password"/>{resetErr && <p className="mt-1 text-xs text-crimson-300">Incorrect password.</p>}<div className="mt-4 flex gap-2"><button onClick={() => setResetOpen(false)} className="btn-ghost flex-1">Cancel</button><button onClick={handleReset} disabled={resetting} className="btn-crimson flex-1">{resetting ? <Loader2 className="h-4 w-4 animate-spin"/> : <Trash2 className="h-4 w-4"/>} Reset</button></div></div></div>}
      <Footer />
    </div>
  );
}

function AdminStat({ label, value, accent }: { label: string; value: number; accent?: 'success' }) {
  return <div className="card p-4"><div className={`font-display text-2xl font-bold ${accent === 'success' ? 'text-success-light' : 'text-ink'}`}>{value}</div><div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div></div>;
}

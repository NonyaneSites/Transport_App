import { useMemo, useState } from 'react';
import { Bus, Car, CheckCircle2, Loader2, Users, AlertTriangle, Smartphone, Wifi, ChevronDown, ChevronRight, Send, UserPlus, XCircle } from 'lucide-react';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { useManifest } from '@/lib/useManifest';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey } from '@/lib/dates';
import { SERVICE_TYPES, type ServiceType, type Passenger } from '@/lib/types';
import { insertAbsentees } from '@/lib/ledger';
import { masterHubForStop, sanitizeTransportValue } from './transportSanitization';

function idsForVehicle(v: any): string[] { return Array.isArray(v?.passengerIds) ? v.passengerIds : Array.isArray(v?.riderIds) ? v.riderIds : Array.isArray(v?.passengers) ? v.passengers : []; }

function vehicleRiders(manifest: any, vehicle: any): Passenger[] {
  const ids = new Set(idsForVehicle(vehicle));
  return (manifest?.signups ?? []).filter((p: Passenger) => ids.has(p.id));
}

export function RepPage() {
  const [date, setDate] = useState(upcomingSunday);
  const [service, setService] = useState<ServiceType>('PM_Normal');
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);
  const [selectedVehicleId, setSelectedVehicleId] = useState('');
  const [repName, setRepName] = useState('');
  const [coRep, setCoRep] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [walkIn, setWalkIn] = useState('');
  const [walkInMsg, setWalkInMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sponsoredIds, setSponsoredIds] = useState<Set<string>>(new Set());

  const serviceLabel = SERVICE_TYPES.find((s) => s.value === service)?.label ?? service;
  const { date: parsedDate } = parseManifestKey(key);
  const selectedVehicle = useMemo(() => manifest?.vehicles.find((v: any) => v.id === selectedVehicleId) ?? null, [manifest, selectedVehicleId]);
  const riders = useMemo(() => selectedVehicle ? vehicleRiders(manifest, selectedVehicle) : [], [manifest, selectedVehicle]);
  const grouped = useMemo(() => {
    const map = new Map<string, Passenger[]>();
    riders.forEach((p) => { const hub = masterHubForStop(p.stop); const list = map.get(hub) ?? []; list.push(p); map.set(hub, list); });
    const order = new Map<string, number>((selectedVehicle?.orderedStops ?? []).map((s: string, i: number) => [s, i]));
    return [...map.entries()].sort((a, b) => (order.get(a[0]) ?? 9999) - (order.get(b[0]) ?? 9999));
  }, [riders, selectedVehicle]);

  const presentCount = riders.filter((r) => r.present).length;
  const absentCount = riders.length - presentCount;
  const sponsoredMissingNotes = riders.some((r) => !r.present && sponsoredIds.has(r.id) && !(notes[r.id] ?? '').trim());
  const canSubmit = !!repName.trim() && !!licensePlate.trim() && !sponsoredMissingNotes && !submitting;
  const assignedRep = (selectedVehicle as any)?.repName || 'Unassigned Rep';

  async function setAttendance(id: string, present: boolean) {
    if (!manifest || !selectedVehicle) return;
    const signups = manifest.signups.map((p) => p.id === id ? { ...p, present } : p);
    await save({ ...manifest, signups });
  }

  async function addCoRep() {
    if (!manifest || !selectedVehicle || !coRep.trim()) return;
    const next = [...(((selectedVehicle as any).coReps ?? []) as string[]), sanitizeTransportValue(coRep)];
    await save({ ...manifest, vehicles: manifest.vehicles.map((v: any) => v.id === selectedVehicle.id ? { ...v, coReps: next } : v) as any });
    setCoRep('');
  }

  async function handleWalkIn() {
    if (!manifest || !selectedVehicle || !walkIn.trim()) return;
    const typed = sanitizeTransportValue(walkIn);
    const normalized = typed.toLowerCase();
    setWalkInMsg(null);
    const found = manifest.signups.find((p) => p.fullName?.toLowerCase() === normalized);
    const owner = found && manifest.vehicles.find((v: any) => idsForVehicle(v).includes(found.id));
    if (owner && owner.id !== selectedVehicle.id) {
      const ok = window.confirm(`This person is assigned to ${owner.name}. Transfer to this taxi?`);
      if (!ok) return;
      const vehicles = manifest.vehicles.map((v: any) => {
        if (v.id === owner.id) return { ...v, passengerIds: idsForVehicle(v).filter((id) => id !== found!.id) };
        if (v.id === selectedVehicle.id) return { ...v, passengerIds: [...new Set([...idsForVehicle(v), found!.id])] };
        return v;
      });
      const signups = manifest.signups.map((p) => p.id === found!.id ? { ...p, present: true } : p);
      await save({ ...manifest, signups, vehicles: vehicles as any });
      setWalkInMsg(`${found.fullName} transferred from ${owner.name} and marked Present.`);
      setWalkIn('');
      return;
    }
    if (found) {
      const vehicles = manifest.vehicles.map((v: any) => v.id === selectedVehicle.id ? { ...v, passengerIds: [...new Set([...idsForVehicle(v), found.id])] } : v);
      const signups = manifest.signups.map((p) => p.id === found.id ? { ...p, present: true } : p);
      await save({ ...manifest, signups, vehicles: vehicles as any });
      setWalkInMsg(`${found.fullName} added and marked Present.`);
      setWalkIn('');
      return;
    }
    const id = `walkin-${Date.now()}`;
    const created = { id, fullName: typed, firstName: typed, surname: '', stop: 'Walk-In', structure: '', present: true, walkIn: true, walkInLabel: '[🚶 Unregistered Walk-In]' } as any as Passenger;
    const vehicles = manifest.vehicles.map((v: any) => v.id === selectedVehicle.id ? { ...v, passengerIds: [...new Set([...idsForVehicle(v), id])] } : v);
    await save({ ...manifest, signups: [...manifest.signups, created], vehicles: vehicles as any });
    setWalkInMsg(`${typed} added as [🚶 Unregistered Walk-In].`);
    setWalkIn('');
  }

  async function handleSubmit() {
    if (!manifest || !selectedVehicle || !canSubmit) return;
    setSubmitting(true); setSubmitMsg(null);
    try {
      const absentees = riders.filter((r) => !r.present).map((r) => ({ ...r, sponsored: sponsoredIds.has(r.id), sponsorNote: notes[r.id] ?? '' }));
      await insertAbsentees(key, parsedDate, serviceLabel, absentees, selectedVehicle.name, repName.trim(), licensePlate.trim(), repName.trim(), '');
      const updatedVehicles = manifest.vehicles.map((v: any) => v.id === selectedVehicle.id ? { ...v, submitted: true, submittedAt: new Date().toISOString(), submittedBy: repName.trim(), licensePlate: licensePlate.trim(), repName: repName.trim() } : v);
      await save({ ...manifest, vehicles: updatedVehicles as any });
      setSubmitMsg(`Submitted! ${presentCount} present, ${absentCount} absent.`);
    } catch (e) { setSubmitMsg(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSubmitting(false); }
  }

  return <div className="min-h-screen bg-bg">
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur-md"><div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/15 border border-success/30"><Smartphone className="h-4 w-4 text-success-light"/></div><div className="flex-1 leading-tight"><div className="font-display text-sm font-bold text-ink">CRC <span className="text-crimson-400">Rep Portal</span></div><div className="flex items-center gap-1 text-[11px] text-muted"><Wifi className="h-3 w-3 text-success"/>Live transport check-in</div></div></div></header>
    <main className="mx-auto max-w-lg px-4 py-5">
      <div className="mb-5 rounded-2xl border border-line bg-card p-5"><span className="badge bg-success/15 text-success-light"><Smartphone className="h-3 w-3"/>Mobile Check-in</span><h1 className="mt-2 font-display text-xl font-bold text-ink">Transport Rep Portal</h1><p className="mt-1.5 text-sm text-muted">Attendance is explicit: every passenger gets separate Present and Absent controls.</p></div>
      <ServiceDateSelector date={date} service={service} onDateChange={setDate} onServiceChange={setService}/>
      {error && <div className="mt-4 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-3 text-sm text-crimson-300"><AlertTriangle className="mr-2 inline h-4 w-4"/>{error}</div>}
      {loading ? <div className="mt-8 flex flex-col items-center gap-3 py-16"><Loader2 className="h-8 w-8 animate-spin text-crimson-400"/>Loading manifest…</div> : !manifest || !manifest.vehicles.length ? <div className="mt-6 rounded-xl border border-line bg-card py-14 text-center"><Bus className="mx-auto h-10 w-10 text-line"/><p className="mt-2 text-sm text-muted">No vehicles dispatched yet.</p></div> : <div className="mt-4 space-y-4">
        <div className="card"><label className="text-xs font-semibold uppercase tracking-wide text-muted">Assigned vehicle</label><select value={selectedVehicleId} onChange={(e) => { setSelectedVehicleId(e.target.value); setSubmitMsg(null); }} className="input-field mt-1.5"><option value="">Choose vehicle…</option>{manifest.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.name} · {idsForVehicle(v).length} passengers</option>)}</select></div>
        {selectedVehicle && <>
          <div className="card"><div className="flex items-center justify-between gap-3"><div><div className="text-xs uppercase tracking-wide text-muted">Assigned Rep</div><div className="mt-1 font-display text-lg font-bold text-ink">{assignedRep}</div></div><button onClick={() => setCoRep(coRep ? '' : ' ')} className="btn-ghost"><UserPlus className="h-4 w-4"/>+ Add Co-Rep</button></div>{coRep !== '' && <div className="mt-3 flex gap-2"><input value={coRep.trim()} onChange={(e) => setCoRep(e.target.value)} placeholder="Co-Rep name" className="input-field flex-1"/><button onClick={addCoRep} className="btn-success">Add</button></div>}<div className="mt-3 flex flex-wrap gap-2">{(((selectedVehicle as any).coReps ?? []) as string[]).map((name) => <span key={name} className="badge bg-card-2 text-muted">Co-Rep: {name}</span>)}</div></div>
          <div className="grid grid-cols-3 gap-2"><Stat label="Total" value={riders.length}/><Stat label="Present" value={presentCount} accent="success"/><Stat label="Absent" value={absentCount} accent="crimson"/></div>
          <div className="card"><div className="flex gap-2"><input value={walkIn} onChange={(e) => setWalkIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void handleWalkIn()} placeholder="Walk-in name" className="input-field flex-1"/><button onClick={() => void handleWalkIn()} className="btn-crimson">+ Add Walk-In</button></div>{walkInMsg && <div className="mt-2 text-xs text-muted">{walkInMsg}</div>}</div>
          {grouped.map(([hub, people]) => <div key={hub} className="overflow-hidden rounded-xl border border-line bg-card"><div className="flex items-center justify-between border-b border-line bg-card-2/50 px-3.5 py-3"><div className="flex items-center gap-2"><MapPinIcon/><span className="font-semibold text-ink">🛑 {hub}</span></div><span className="text-xs text-muted">{people.filter((p) => p.present).length}/{people.length}</span></div><div className="divide-y divide-line/60">{people.map((p) => <div key={p.id} className="p-3.5"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="text-sm font-medium text-ink">{p.fullName}</div>{(p as any).walkIn && <div className="mt-0.5 text-[10px] font-semibold text-warning">[🚶 Unregistered Walk-In]</div>}</div><div className="flex shrink-0 gap-2"><button onClick={() => void setAttendance(p.id, true)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${p.present ? 'border-success/40 bg-success/15 text-success-light' : 'border-line bg-card-2 text-muted'}`}>Present</button><button onClick={() => void setAttendance(p.id, false)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${!p.present ? 'border-crimson-500/40 bg-crimson-500/15 text-crimson-300' : 'border-line bg-card-2 text-muted'}`}>Absent</button></div></div></div>)}</div></div>)}
          {!selectedVehicle.submitted && <><div className="card"><div className="grid gap-3"><input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Your name" className="input-field"/><input value={licensePlate} onChange={(e) => setLicensePlate(e.target.value.toUpperCase())} placeholder="License plate" className="input-field"/></div></div>{sponsoredMissingNotes && <div className="text-xs text-warning">Sponsored absentees require a sponsor note before submission.</div>}<button onClick={() => void handleSubmit()} disabled={!canSubmit} className="btn-crimson w-full py-3.5"><Send className="h-5 w-5"/>{submitting ? 'Submitting…' : 'Submit Attendance'}</button></>}
          {submitMsg && <div className="rounded-lg border border-line bg-card p-3 text-sm text-muted">{submitMsg}</div>}
        </>}
      </div>}
    </main>
  </div>;
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'success' | 'crimson' }) { return <div className={`rounded-xl border p-2.5 text-center ${accent === 'success' ? 'border-success/30 bg-success/10' : accent === 'crimson' ? 'border-crimson-500/30 bg-crimson-900/10' : 'border-line bg-card'}`}><div className={`font-display text-xl font-bold ${accent === 'success' ? 'text-success-light' : accent === 'crimson' ? 'text-crimson-400' : 'text-ink'}`}>{value}</div><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div></div>; }
function MapPinIcon() { return <span aria-hidden="true" className="text-crimson-400">🛑</span>; }

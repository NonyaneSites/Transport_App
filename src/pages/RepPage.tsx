import { useEffect, useMemo, useState } from 'react';
import {
  Bus, Car, CheckCircle2, XCircle, Loader2, Users, AlertTriangle,
  Smartphone, Wifi, ChevronDown, ChevronRight, MapPin, Send, Cross,
  HeartHandshake, StickyNote, UserPlus, Users2, X, Wallet, Plus, Search, Banknote,
} from 'lucide-react';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { useManifest } from '@/lib/useManifest';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey, shortDate } from '@/lib/dates';
import { SERVICE_TYPES, CANCELLATION_FEE, sortByRouteSequence, type ServiceType, type Passenger, type Vehicle } from '@/lib/types';
import { hubDisplayName } from '@/lib/types';
import { sortVehiclesNatural } from '@/lib/sort';
import { vehicleRiders, passengersByStop } from '@/lib/manifest';
import { insertAbsentees, listLedgerEntries, settleLedgerEntries, type LedgerEntry } from '@/lib/ledger';

const FARE = CANCELLATION_FEE; // R40 fixed passenger fare — never individually editable

interface ExternalSponsee {
  id: string;
  sponseeName: string;
  taxiName: string;
  amount: number;
}

interface RepDraft {
  touchedIds: string[];
  sponsoredIds: string[];
  notes: Record<string, string>;
  generalNotes: string;
  coReps: string[];
  externalSponsees: ExternalSponsee[];
  /** IDs of `cancellation_ledger` rows this rep is collecting R40 cash for during this trip. */
  collectedCancellationIds: string[];
}

function draftKey(manifestKeyStr: string, vehicleId: string): string {
  return `rep_draft_${manifestKeyStr}_${vehicleId}`;
}

export function RepPage() {
  const [date, setDate] = useState(upcomingSunday);
  const [service, setService] = useState<ServiceType>('PM_Normal');
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);

  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('');
  const [repName, setRepName] = useState('');
  const [coReps, setCoReps] = useState<string[]>([]);
  const [licensePlate, setLicensePlate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sponsoredIds, setSponsoredIds] = useState<Set<string>>(new Set());
  const [generalNotes, setGeneralNotes] = useState('');
  const [touchedIds, setTouchedIds] = useState<Set<string>>(new Set());

  // Cash & sponsorship calculator
  const [externalSponsees, setExternalSponsees] = useState<ExternalSponsee[]>([]);

  // Past-cancellation cash collection
  const [pastCancellations, setPastCancellations] = useState<LedgerEntry[]>([]);
  const [loadingPastCancellations, setLoadingPastCancellations] = useState(false);
  const [collectedCancellationIds, setCollectedCancellationIds] = useState<Set<string>>(new Set());
  const [cancellationSearch, setCancellationSearch] = useState('');

  // Draft auto-save/restore
  const [draftRestored, setDraftRestored] = useState(false);

  // Walk-in
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [transferPrompt, setTransferPrompt] = useState<{ passenger: Passenger; fromVehicle: Vehicle } | null>(null);

  const serviceLabel = SERVICE_TYPES.find((s) => s.value === service)?.label ?? service;
  const { date: parsedDate } = parseManifestKey(key);

  const selectedVehicle = useMemo(
    () => manifest?.vehicles.find((v) => v.id === selectedVehicleId) ?? null,
    [manifest, selectedVehicleId]
  );

  const riders = useMemo(
    () => selectedVehicle ? vehicleRiders(manifest, selectedVehicle) : [],
    [manifest, selectedVehicle]
  );

  // Auto-match: as the Rep types their name, highlight/select the vehicle
  // the Admin assigned them to (only while nothing is selected yet, so we
  // never yank a vehicle they picked on purpose).
  useEffect(() => {
    if (!manifest || selectedVehicleId) return;
    const q = repName.trim().toLowerCase();
    if (q.length < 2) return;
    const match = manifest.vehicles.find((v) => (v.repName ?? '').trim().toLowerCase() === q);
    if (match) setSelectedVehicleId(match.id);
  }, [repName, manifest, selectedVehicleId]);

  // Reset per-session state whenever the rep switches vehicles, then try to
  // restore a local draft for the new vehicle (attendance touches, notes,
  // sponsorship, cash calculator) before anything is submitted.
  useEffect(() => {
    setWalkInOpen(false);
    setWalkInName('');
    setTransferPrompt(null);

    if (!selectedVehicleId) {
      setTouchedIds(new Set());
      setSponsoredIds(new Set());
      setNotes({});
      setGeneralNotes('');
      setCoReps([]);
      setExternalSponsees([]);
      setCollectedCancellationIds(new Set());
      setDraftRestored(false);
      return;
    }

    const vehicle = manifest?.vehicles.find((v) => v.id === selectedVehicleId);
    let restored = false;
    if (vehicle && !vehicle.submitted) {
      try {
        const raw = localStorage.getItem(draftKey(key, selectedVehicleId));
        if (raw) {
          const draft: RepDraft = JSON.parse(raw);
          setTouchedIds(new Set(draft.touchedIds ?? []));
          setSponsoredIds(new Set(draft.sponsoredIds ?? []));
          setNotes(draft.notes ?? {});
          setGeneralNotes(draft.generalNotes ?? '');
          setCoReps(draft.coReps ?? []);
          setExternalSponsees(draft.externalSponsees ?? []);
          setCollectedCancellationIds(new Set(draft.collectedCancellationIds ?? []));
          restored = true;
        }
      } catch { /* corrupt draft — ignore and start fresh */ }
    }
    if (!restored) {
      setTouchedIds(new Set());
      setSponsoredIds(new Set());
      setNotes({});
      setGeneralNotes('');
      setCoReps([]);
      setExternalSponsees([]);
      setCollectedCancellationIds(new Set());
    }
    setDraftRestored(restored);
    if (restored) {
      const t = setTimeout(() => setDraftRestored(false), 6000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVehicleId]);

  // Instant local persistence — save on every relevant change so a rep who
  // loses signal or closes the tab doesn't lose their in-progress checklist.
  useEffect(() => {
    if (!selectedVehicleId || !selectedVehicle || selectedVehicle.submitted) return;
    const draft: RepDraft = {
      touchedIds: Array.from(touchedIds),
      sponsoredIds: Array.from(sponsoredIds),
      notes,
      generalNotes,
      coReps,
      externalSponsees,
      collectedCancellationIds: Array.from(collectedCancellationIds),
    };
    try {
      localStorage.setItem(draftKey(key, selectedVehicleId), JSON.stringify(draft));
    } catch { /* storage unavailable — draft just won't persist */ }
  }, [key, selectedVehicleId, selectedVehicle, touchedIds, sponsoredIds, notes, generalNotes, coReps, externalSponsees, collectedCancellationIds]);

  // Load outstanding past-cancellation debts once, so any Rep can collect
  // cash on behalf of someone in a different vehicle/structure.
  useEffect(() => {
    let mounted = true;
    setLoadingPastCancellations(true);
    (async () => {
      try {
        const entries = await listLedgerEntries();
        if (mounted) setPastCancellations(entries);
      } catch { /* non-critical — picker will just show empty */ }
      finally { if (mounted) setLoadingPastCancellations(false); }
    })();
    return () => { mounted = false; };
  }, []);

  const presentCount = riders.filter((r) => r.present).length;
  const absentCount = riders.length - presentCount;
  const allTouched = riders.length > 0 && riders.every((r) => touchedIds.has(r.id));

  // Can only submit if rep name AND license plate are filled, and every
  // passenger has been explicitly marked Present or Absent this session.
  const sponsoredMissingNotes = riders.some(
    (r) => !r.present && sponsoredIds.has(r.id) && !(notes[r.id] ?? '').trim()
  );
  const canSubmit =
    repName.trim().length > 0 &&
    licensePlate.trim().length > 0 &&
    allTouched &&
    !sponsoredMissingNotes &&
    !submitting;

  // Cash calculator totals — base fare is fixed at R40/present passenger
  // and is never individually editable.
  // Total = (Present * 40) - (Sponsored Present * 40) + External Sponsee Cash + Past Cancellation Cash Collected
  const presentSponsoredCount = riders.filter((r) => r.present && sponsoredIds.has(r.id)).length;
  const grossPresentCash = presentCount * FARE;
  const sponsoredDeduction = presentSponsoredCount * FARE;
  const baseCash = grossPresentCash - sponsoredDeduction;
  const externalCash = externalSponsees.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const pastCancellationCash = collectedCancellationIds.size * FARE;
  const totalCash = baseCash + externalCash + pastCancellationCash;

  async function setPresent(passengerId: string, present: boolean) {
    if (!manifest) return;
    const updatedSignups = manifest.signups.map((p) =>
      p.id === passengerId ? { ...p, present } : p
    );
    setTouchedIds((prev) => new Set(prev).add(passengerId));
    await save({ ...manifest, signups: updatedSignups });
  }

  function toggleSponsored(passengerId: string) {
    setSponsoredIds((prev) => {
      const next = new Set(prev);
      if (next.has(passengerId)) next.delete(passengerId);
      else next.add(passengerId);
      return next;
    });
  }

  function setNote(passengerId: string, text: string) {
    setNotes((prev) => ({ ...prev, [passengerId]: text }));
  }

  function addCoRep() {
    setCoReps((prev) => [...prev, '']);
  }

  function updateCoRep(index: number, value: string) {
    setCoReps((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function removeCoRep(index: number) {
    setCoReps((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleCollectedCancellation(entryId: string) {
    setCollectedCancellationIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function addExternalSponsee() {
    setExternalSponsees((prev) => [
      ...prev,
      { id: `sponsee-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sponseeName: '', taxiName: '', amount: FARE },
    ]);
  }

  function updateExternalSponsee(id: string, patch: Partial<ExternalSponsee>) {
    setExternalSponsees((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeExternalSponsee(id: string) {
    setExternalSponsees((prev) => prev.filter((s) => s.id !== id));
  }

  function findByName(name: string): Passenger | undefined {
    const q = name.trim().toLowerCase();
    if (!q || !manifest) return undefined;
    return manifest.signups.find((p) => p.fullName.trim().toLowerCase() === q)
      ?? manifest.signups.find((p) => p.fullName.trim().toLowerCase().includes(q));
  }

  function vehicleFor(vehicleId: string | null): Vehicle | undefined {
    return manifest?.vehicles.find((v) => v.id === vehicleId) ?? undefined;
  }

  function orderedStopsWith(vehicle: Vehicle, poolKey: string): string[] {
    const existing = vehicle.orderedStops ?? [];
    return existing.includes(poolKey) ? existing : [...existing, poolKey];
  }

  async function handleAddWalkIn() {
    if (!manifest || !selectedVehicle || !walkInName.trim()) return;
    const existing = findByName(walkInName);

    if (existing && existing.assignedTo && existing.assignedTo !== selectedVehicle.id) {
      // Ask before pulling them out of their current vehicle.
      const fromVehicle = vehicleFor(existing.assignedTo);
      if (fromVehicle) {
        setTransferPrompt({ passenger: existing, fromVehicle });
        return;
      }
    }

    if (existing) {
      // Already unassigned, or already in this vehicle — just (re)assign here.
      await assignWalkIn(existing, existing.assignedTo);
    } else {
      // Brand-new person, not from the Excel import.
      const newPassenger: Passenger = {
        id: `walkin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fullName: walkInName.trim(),
        stop: 'Walk-In',
        structure: '',
        assignedTo: selectedVehicle.id,
        present: true,
        cancellationFeeOwed: false,
      };
      const poolKey = hubDisplayName(selectedVehicle.type, newPassenger.stop);
      const updatedVehicles = manifest.vehicles.map((v) =>
        v.id === selectedVehicle.id
          ? { ...v, riders: [...v.riders, newPassenger.id], orderedStops: orderedStopsWith(v, poolKey) }
          : v
      );
      await save({ ...manifest, signups: [...manifest.signups, newPassenger], vehicles: updatedVehicles });
      setTouchedIds((prev) => new Set(prev).add(newPassenger.id));
    }
    setWalkInName('');
    setWalkInOpen(false);
  }

  async function assignWalkIn(passenger: Passenger, fromVehicleId: string | null) {
    if (!manifest || !selectedVehicle) return;
    const poolKey = hubDisplayName(selectedVehicle.type, passenger.stop);
    const updatedSignups = manifest.signups.map((p) =>
      p.id === passenger.id ? { ...p, assignedTo: selectedVehicle.id, present: true } : p
    );
    const updatedVehicles = manifest.vehicles.map((v) => {
      if (fromVehicleId && v.id === fromVehicleId) {
        return { ...v, riders: v.riders.filter((id) => id !== passenger.id) };
      }
      if (v.id === selectedVehicle.id) {
        if (v.riders.includes(passenger.id)) return v;
        return { ...v, riders: [...v.riders, passenger.id], orderedStops: orderedStopsWith(v, poolKey) };
      }
      return v;
    });
    await save({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
    setTouchedIds((prev) => new Set(prev).add(passenger.id));
  }

  async function confirmTransfer() {
    if (!transferPrompt) return;
    await assignWalkIn(transferPrompt.passenger, transferPrompt.fromVehicle.id);
    setTransferPrompt(null);
    setWalkInName('');
    setWalkInOpen(false);
  }

  async function handleSubmit() {
    if (!manifest || !selectedVehicle) return;
    if (!repName.trim() || !licensePlate.trim()) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const absentees = riders
        .filter((r) => !r.present)
        .map((r) => ({
          ...r,
          sponsored: sponsoredIds.has(r.id),
          sponsorNote: notes[r.id] ?? '',
        }));

      const repDisplayName = [repName.trim(), ...coReps.map((c) => c.trim()).filter(Boolean)].join(' & ');
      const coRepNote = coReps.map((c) => c.trim()).filter(Boolean).length > 0
        ? `Co-reps: ${coReps.map((c) => c.trim()).filter(Boolean).join(', ')}. `
        : '';
      const cashNote = `Cash collected: R${totalCash} (base R${baseCash}${externalCash > 0 ? ` + external R${externalCash}` : ''}${pastCancellationCash > 0 ? ` + past cancellations R${pastCancellationCash}` : ''}). `;
      const sponseeNote = externalSponsees.length > 0
        ? `External sponsees: ${externalSponsees.map((s) => `${s.sponseeName || 'Unnamed'} in ${s.taxiName || 'another vehicle'} (R${s.amount})`).join('; ')}. `
        : '';
      const settledNames = pastCancellations
        .filter((e) => collectedCancellationIds.has(e.id))
        .map((e) => e.passenger_name);
      const settledNote = settledNames.length > 0
        ? `Past cancellations collected in cash: ${settledNames.join(', ')}. `
        : '';

      // insertAbsentees deduplicates strictly by manifest_key + passenger_name
      // (across this vehicle's full roster, present and absent) before
      // inserting — so resubmitting never leaves a duplicate debt row.
      await insertAbsentees(
        key,
        parsedDate,
        serviceLabel,
        absentees,
        riders.map((r) => r.fullName),
        selectedVehicle.name,
        repName.trim(),
        licensePlate.trim(),
        repDisplayName,
        `${coRepNote}${cashNote}${sponseeNote}${settledNote}${generalNotes.trim()}`.trim()
      );

      // Resolve/settle the past-cancellation entries collected in cash on
      // this trip so they drop off the active cancellation ledger.
      if (collectedCancellationIds.size > 0) {
        await settleLedgerEntries(Array.from(collectedCancellationIds));
        setPastCancellations((prev) => prev.filter((e) => !collectedCancellationIds.has(e.id)));
        setCollectedCancellationIds(new Set());
      }

      const updatedVehicles = manifest.vehicles.map((v) =>
        v.id === selectedVehicle.id
          ? {
              ...v,
              submitted: true,
              submittedAt: new Date().toISOString(),
              submittedBy: repName.trim(),
              licensePlate: licensePlate.trim(),
              repName: repName.trim(),
              coReps: coReps.map((c) => c.trim()).filter(Boolean),
              generalNotes: generalNotes.trim(),
            }
          : v
      );
      await save({ ...manifest, vehicles: updatedVehicles });

      // Draft is only ever cleared on a successful submit to Supabase.
      try { localStorage.removeItem(draftKey(key, selectedVehicle.id)); } catch { /* ignore */ }

      setSubmitMsg(
        `Submitted! ${presentCount} present, ${absentCount} absent. ` +
        `${absentees.length > 0 ? `${absentees.length} absentees added to cancellation ledger. ` : ''}` +
        `Thank you, ${repDisplayName}.`
      );
    } catch (e) {
      setSubmitMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const isSubmitted = selectedVehicle?.submitted ?? false;

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/15 border border-success/30">
            <Smartphone className="h-4 w-4 text-success-light" />
          </div>
          <div className="flex-1 leading-tight">
            <div className="font-display text-sm font-bold tracking-tight text-ink">
              CRC <span className="text-crimson-400">Rep Portal</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted">
              <Wifi className="h-3 w-3 text-success" />
              <span>Live transport check-in</span>
            </div>
          </div>
          <Cross className="h-5 w-5 text-muted" strokeWidth={2} />
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-5">
        <div className="mb-5 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-card to-bg p-5">
          <span className="badge bg-success/15 text-success-light">
            <Smartphone className="h-3 w-3" />
            Mobile Check-in
          </span>
          <h1 className="mt-2 font-display text-xl font-bold tracking-tight text-ink">
            Transport Rep Portal
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Enter your name to find your assigned vehicle, mark every passenger Present or Absent, and submit
            attendance. You must enter your name and the vehicle's license plate before submitting.
          </p>
        </div>

        <ServiceDateSelector
          date={date}
          service={service}
          onDateChange={setDate}
          onServiceChange={setService}
        />

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-3 text-sm text-crimson-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="mt-8 flex flex-col items-center gap-3 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-crimson-400" />
            <p className="text-sm text-muted">Loading manifest…</p>
          </div>
        ) : !manifest || manifest.vehicles.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-line bg-card py-14 text-center">
            <Bus className="h-10 w-10 text-line" />
            <p className="text-sm text-muted">No vehicles dispatched for this session yet.</p>
            <p className="text-xs text-muted">{prettyDate(date)} · {serviceLabel}</p>
            <p className="text-xs text-muted">
              The admin will assign you a taxi or bus — check back once they've allocated.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Rep name + vehicle picker */}
            <div className="card">
              <div className="mb-3 flex items-center gap-2">
                <div className="h-5 w-1 rounded-full bg-crimson-500" />
                <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">
                  Select Your Vehicle
                </h2>
              </div>

              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                Your Name <span className="text-crimson-400">*</span>
              </label>
              <input
                type="text"
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                placeholder="Start typing your name…"
                className="input-field mb-1.5"
              />
              {selectedVehicle && repName.trim() && (selectedVehicle.repName ?? '').trim().toLowerCase() === repName.trim().toLowerCase() && (
                <p className="mb-3 flex items-center gap-1 text-xs text-success-light">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Auto-selected {selectedVehicle.name} — you're the assigned rep.
                </p>
              )}

              <p className="mb-3 text-xs text-muted">
                Or pick the taxi or bus the admin assigned you directly. Each rep handles their own vehicle.
              </p>
              <div className="relative">
                <Car className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <select
                  value={selectedVehicleId}
                  onChange={(e) => {
                    setSelectedVehicleId(e.target.value);
                    setSubmitMsg(null);
                  }}
                  className="input-field pl-10"
                >
                  <option value="" className="bg-card-2">Choose your vehicle…</option>
                  {sortVehiclesNatural(manifest.vehicles).map((v) => {
                    const vRiders = vehicleRiders(manifest, v);
                    const vPresent = vRiders.filter((r) => r.present).length;
                    return (
                      <option key={v.id} value={v.id} className="bg-card-2">
                        {v.name} — Assigned Rep: {v.repName || 'Unassigned'} ({v.type}) — {vRiders.length} passengers
                        {v.submitted ? ' ✓ submitted' : ` (${vPresent}/${vRiders.length} checked)`}
                      </option>
                    );
                  })}
                </select>
              </div>

              {selectedVehicleId && (
                <div className="mt-3 space-y-3">
                  {/* Co-Reps */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                        Co-Reps (optional)
                      </label>
                      <button onClick={addCoRep} className="flex items-center gap-1 text-xs font-semibold text-crimson-400 hover:text-crimson-300">
                        <Users2 className="h-3.5 w-3.5" />
                        + Add Co-Rep
                      </button>
                    </div>
                    {coReps.length > 0 && (
                      <div className="space-y-1.5">
                        {coReps.map((c, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={c}
                              onChange={(e) => updateCoRep(i, e.target.value)}
                              placeholder="Co-rep name"
                              className="input-field py-1.5 text-xs"
                            />
                            <button onClick={() => removeCoRep(i)} className="rounded-md p-1.5 text-muted hover:bg-crimson-900/30 hover:text-crimson-300" title="Remove">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                      License Plate <span className="text-crimson-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={licensePlate}
                      onChange={(e) => setLicensePlate(e.target.value)}
                      placeholder="Required — e.g. GP 123 ABC"
                      className="input-field uppercase"
                    />
                  </div>
                </div>
              )}
            </div>

            {selectedVehicle && draftRestored && (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-2.5 text-xs text-success-light">
                🟢 Draft auto-restored
              </div>
            )}

            {selectedVehicle && riders.length > 0 && (
              <>
                {/* Stats bar */}
                <div className="grid grid-cols-3 gap-2">
                  <StatCard label="Total" value={riders.length} icon={<Users className="h-4 w-4" />} />
                  <StatCard label="Present" value={presentCount} icon={<CheckCircle2 className="h-4 w-4" />} accent="success" />
                  <StatCard label="Absent" value={absentCount} icon={<AlertTriangle className="h-4 w-4" />} accent="crimson" />
                </div>

                {isSubmitted && (
                  <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success-light">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <div>
                      <div className="font-semibold">Attendance submitted</div>
                      <div className="text-xs text-muted">
                        Submitted by {selectedVehicle.submittedBy || 'rep'}
                        {selectedVehicle.licensePlate && ` · Plate: ${selectedVehicle.licensePlate}`}
                        {selectedVehicle.submittedAt &&
                          ` at ${new Date(selectedVehicle.submittedAt).toLocaleString('en-ZA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`}
                      </div>
                    </div>
                  </div>
                )}

                {/* Walk-in */}
                {!isSubmitted && (
                  <div className="card">
                    {!walkInOpen ? (
                      <button
                        onClick={() => setWalkInOpen(true)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line py-2.5 text-xs font-semibold text-muted hover:border-crimson-500/40 hover:text-crimson-300"
                      >
                        <UserPlus className="h-4 w-4" />
                        + Add Walk-In
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                          Walk-In Passenger Name
                        </label>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={walkInName}
                            onChange={(e) => setWalkInName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddWalkIn()}
                            placeholder="Type the passenger's name"
                            className="input-field text-xs"
                            autoFocus
                          />
                          <button
                            onClick={handleAddWalkIn}
                            disabled={!walkInName.trim()}
                            className="btn-crimson px-3 py-2 text-xs whitespace-nowrap"
                          >
                            Add
                          </button>
                          <button
                            onClick={() => { setWalkInOpen(false); setWalkInName(''); }}
                            className="btn-ghost px-3 py-2 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-[10px] text-muted">
                          We'll check if they're already assigned elsewhere before adding them here.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <StopGroupedChecklist
                  riders={riders}
                  touchedIds={touchedIds}
                  onSetPresent={setPresent}
                  onToggleSponsored={toggleSponsored}
                  onSetNote={setNote}
                  sponsoredIds={sponsoredIds}
                  notes={notes}
                  disabled={isSubmitted || submitting}
                />

                {!isSubmitted && (
                  <>
                    {/* General notes for this vehicle submission */}
                    <div className="card">
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                        General Notes (optional)
                      </label>
                      <textarea
                        value={generalNotes}
                        onChange={(e) => setGeneralNotes(e.target.value)}
                        placeholder="Any notes for this vehicle's submission — e.g. 'Person A in Taxi 1 is paying for Person B in Taxi 2'"
                        rows={2}
                        className="input-field text-xs resize-none"
                      />
                    </div>

                    {/* Read-only cash summary — sits directly above the submit
                        button, per policy. Base fare is fixed at R40/present
                        passenger and is never individually editable. */}
                    <CashCalculatorCard
                      presentCount={presentCount}
                      presentSponsoredCount={presentSponsoredCount}
                      fare={FARE}
                      grossPresentCash={grossPresentCash}
                      sponsoredDeduction={sponsoredDeduction}
                      externalSponsees={externalSponsees}
                      onAddSponsee={addExternalSponsee}
                      onUpdateSponsee={updateExternalSponsee}
                      onRemoveSponsee={removeExternalSponsee}
                      externalCash={externalCash}
                      pastCancellations={pastCancellations}
                      loadingPastCancellations={loadingPastCancellations}
                      collectedCancellationIds={collectedCancellationIds}
                      onToggleCancellation={toggleCollectedCancellation}
                      pastCancellationCash={pastCancellationCash}
                      search={cancellationSearch}
                      onSearchChange={setCancellationSearch}
                      baseCash={baseCash}
                      totalCash={totalCash}
                    />

                    {!allTouched && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Every passenger must be marked Present or Absent before you can submit.
                      </div>
                    )}

                    {sponsoredMissingNotes && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        All sponsored passengers must have a note saying who is paying for them.
                      </div>
                    )}

                    <button
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      className={`w-full py-3.5 text-base ${
                        canSubmit ? 'btn-crimson' : 'cursor-not-allowed rounded-xl border border-line bg-card-2 text-muted'
                      }`}
                    >
                      {submitting ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          Submitting…
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Send className="h-5 w-5" />
                          Submit Attendance
                        </span>
                      )}
                    </button>
                    {!canSubmit && !sponsoredMissingNotes && allTouched && (
                      <p className="text-center text-xs text-muted">
                        Enter your name and license plate above to enable submission.
                      </p>
                    )}
                  </>
                )}

                {submitMsg && (
                  <div
                    className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                      submitMsg.startsWith('Error')
                        ? 'border-crimson-500/30 bg-crimson-900/20 text-crimson-300'
                        : 'border-success/30 bg-success/10 text-success-light'
                    }`}
                  >
                    {submitMsg.startsWith('Error') ? (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <span>{submitMsg}</span>
                  </div>
                )}

                {isSubmitted && (
                  <button
                    onClick={() => {
                      setSubmitMsg(null);
                      if (manifest && selectedVehicle) {
                        const updatedVehicles = manifest.vehicles.map((v) =>
                          v.id === selectedVehicle.id
                            ? { ...v, submitted: false, submittedAt: undefined, submittedBy: undefined }
                            : v
                        );
                        save({ ...manifest, vehicles: updatedVehicles });
                      }
                    }}
                    className="btn-ghost w-full text-xs"
                  >
                    Re-open for editing
                  </button>
                )}
              </>
            )}

            {selectedVehicle && riders.length === 0 && (
              <div className="rounded-xl border border-line bg-card p-8 text-center">
                <Users className="mx-auto h-8 w-8 text-line" />
                <p className="mt-2 text-sm text-muted">No passengers assigned to this vehicle yet.</p>
              </div>
            )}
          </div>
        )}

        <footer className="mt-10 border-t border-line pt-4 text-center">
          <p className="text-[11px] text-muted">
            CRC Johannesburg · Transport Ministry · 2026 — The Year of Invasion
          </p>
        </footer>
      </main>

      {/* Walk-in transfer confirmation */}
      {transferPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in"
          onClick={() => setTransferPrompt(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-crimson animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning/15 border border-warning/30">
                <AlertTriangle className="h-5 w-5 text-warning" />
              </div>
              <div>
                <h3 className="font-display text-base font-bold text-ink">Already Assigned</h3>
                <p className="text-xs text-muted">
                  This person is assigned to <span className="font-semibold text-ink">{transferPrompt.fromVehicle.name}</span>.
                  Transfer them to this vehicle?
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setTransferPrompt(null); }} className="btn-ghost flex-1">
                Cancel
              </button>
              <button onClick={confirmTransfer} className="btn-crimson flex-1">
                Transfer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label, value, icon, accent,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent?: 'success' | 'crimson';
}) {
  const color = accent === 'success' ? 'text-success-light' : accent === 'crimson' ? 'text-crimson-400' : 'text-ink';
  const border = accent === 'success' ? 'border-success/30 bg-success/10' : accent === 'crimson' ? 'border-crimson-500/30 bg-crimson-900/10' : 'border-line bg-card';
  return (
    <div className={`rounded-xl border p-2.5 text-center ${border}`}>
      <div className={`flex items-center justify-center gap-1.5 ${color}`}>
        {icon}
        <span className="font-display text-xl font-bold">{value}</span>
      </div>
      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

/** Renders an entry's stored service label (e.g. "PM Service — Normal Only") as "PM Normal" / "AM Serving". */
function formatServicePeriodMode(service: string): string {
  const parts = service.split('—').map((s) => s.trim());
  const period = (parts[0] ?? '').split(' ')[0] || '';
  const mode = (parts[1] ?? '').replace(/only/i, '').trim();
  return [period, mode].filter(Boolean).join(' ') || service;
}

function CashCalculatorCard({
  presentCount, presentSponsoredCount, fare, grossPresentCash, sponsoredDeduction,
  externalSponsees, onAddSponsee, onUpdateSponsee, onRemoveSponsee, externalCash,
  pastCancellations, loadingPastCancellations, collectedCancellationIds, onToggleCancellation,
  pastCancellationCash, search, onSearchChange,
  baseCash, totalCash,
}: {
  presentCount: number;
  presentSponsoredCount: number;
  fare: number;
  grossPresentCash: number;
  sponsoredDeduction: number;
  externalSponsees: ExternalSponsee[];
  onAddSponsee: () => void;
  onUpdateSponsee: (id: string, patch: Partial<ExternalSponsee>) => void;
  onRemoveSponsee: (id: string) => void;
  externalCash: number;
  pastCancellations: LedgerEntry[];
  loadingPastCancellations: boolean;
  collectedCancellationIds: Set<string>;
  onToggleCancellation: (id: string) => void;
  pastCancellationCash: number;
  search: string;
  onSearchChange: (v: string) => void;
  baseCash: number;
  totalCash: number;
}) {
  const q = search.trim().toLowerCase();
  // Selected debts are shown separately, so search results only ever
  // surface still-outstanding ("active") records the Rep hasn't picked yet.
  const selectedCancellations = pastCancellations.filter((e) => collectedCancellationIds.has(e.id));
  const searchResults = q.length === 0 ? [] : pastCancellations.filter((e) => {
    if (collectedCancellationIds.has(e.id)) return false;
    return e.passenger_name.toLowerCase().includes(q) || (e.structure || '').toLowerCase().includes(q);
  });

  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="h-4 w-4 text-crimson-400" />
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Physical Cash Calculator</h2>
      </div>

      {/* Read-only base fare summary — R40/present passenger is fixed and cannot be edited per-passenger. */}
      <div className="space-y-1.5 rounded-lg bg-card-2/60 p-3 text-xs">
        <div className="flex items-center justify-between text-muted">
          <span>Present Passengers</span>
          <span className="font-mono font-semibold text-ink">{presentCount} × R{fare} = R{grossPresentCash}</span>
        </div>
        {presentSponsoredCount > 0 && (
          <div className="flex items-center justify-between text-muted">
            <span>- Sponsored (Present, didn't pay)</span>
            <span className="font-mono font-semibold text-warning">{presentSponsoredCount} × R{fare} = -R{sponsoredDeduction}</span>
          </div>
        )}
      </div>

      {/* External sponsees — cash collected here for a passenger in another vehicle */}
      <div className="mt-3">
        <button onClick={onAddSponsee} className="flex items-center gap-1.5 text-xs font-semibold text-crimson-400 hover:text-crimson-300">
          <Plus className="h-3.5 w-3.5" />
          + Add External Sponsee Cash
        </button>
        {externalSponsees.length > 0 && (
          <div className="mt-2 space-y-2">
            {externalSponsees.map((s) => (
              <div key={s.id} className="flex flex-col gap-1.5 rounded-lg border border-line bg-card-2/60 p-2.5 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={s.sponseeName}
                  onChange={(e) => onUpdateSponsee(s.id, { sponseeName: e.target.value })}
                  placeholder="Sponsee name"
                  className="input-field py-1.5 text-xs sm:flex-1"
                />
                <input
                  type="text"
                  value={s.taxiName}
                  onChange={(e) => onUpdateSponsee(s.id, { taxiName: e.target.value })}
                  placeholder="In which taxi? (e.g. Taxi 2)"
                  className="input-field py-1.5 text-xs sm:flex-1"
                />
                <div className="flex items-center gap-1 text-xs text-muted">
                  R
                  <input
                    type="number"
                    min="0"
                    value={s.amount}
                    onChange={(e) => onUpdateSponsee(s.id, { amount: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    className="input-field w-16 py-1 text-center text-xs"
                  />
                </div>
                <button onClick={() => onRemoveSponsee(s.id)} className="rounded-md p-1.5 text-muted hover:bg-crimson-900/30 hover:text-crimson-300" title="Remove">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Search-based past-cancellation cash settlement */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-crimson-400">
          <Banknote className="h-3.5 w-3.5" />
          Settle a Past Cancellation (Cash)
          {collectedCancellationIds.size > 0 && (
            <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px]">{collectedCancellationIds.size} selected</span>
          )}
        </div>

        {/* Already-selected debts, with a way to deselect */}
        {selectedCancellations.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {selectedCancellations.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-2 rounded-md border border-crimson-500/40 bg-crimson-500/10 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-crimson-200">
                  <span className="font-semibold">{e.passenger_name}</span>
                  <span className="text-muted"> — {shortDate(e.date)} · {formatServicePeriodMode(e.service)}</span>
                </span>
                <button
                  onClick={() => onToggleCancellation(e.id)}
                  className="shrink-0 rounded p-1 text-muted hover:bg-crimson-900/30 hover:text-crimson-300"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by name or structure to settle a past cancellation…"
            className="input-field py-1.5 pl-8 text-xs"
          />
        </div>

        {search.trim().length > 0 && (
          <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-card-2/40 p-2 animate-fade-in">
            {loadingPastCancellations ? (
              <p className="py-2 text-center text-[11px] text-muted">Loading outstanding cancellations…</p>
            ) : searchResults.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-muted">No outstanding cancellations match your search.</p>
            ) : (
              searchResults.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onToggleCancellation(e.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-card px-2.5 py-2 text-left text-xs transition-colors hover:border-crimson-500/40 hover:bg-card-2/60"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ink">{e.passenger_name}</span>
                    <span className="mt-0.5 block text-[10px] text-muted">
                      {shortDate(e.date)} · {formatServicePeriodMode(e.service)}
                      {e.structure && ` · ${e.structure}`}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">R{fare}</span>
                </button>
              ))
            )}
          </div>
        )}

        <p className="mt-1.5 text-[10px] text-muted">
          Selecting a match adds R{fare} to this vehicle's expected cash and clears that person's debt on submit.
        </p>
      </div>

      {/* Live total */}
      <div className="mt-3 space-y-1 rounded-lg border border-crimson-500/20 bg-crimson-900/10 p-3 text-xs">
        <div className="flex items-center justify-between text-muted">
          <span>Base Passenger Cash</span>
          <span className="font-mono font-semibold text-ink">R{baseCash}</span>
        </div>
        <div className="flex items-center justify-between text-muted">
          <span>+ External Sponsee Cash</span>
          <span className="font-mono font-semibold text-ink">R{externalCash}</span>
        </div>
        <div className="flex items-center justify-between text-muted">
          <span>+ Past Cancellation Cash Collected</span>
          <span className="font-mono font-semibold text-ink">R{pastCancellationCash}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-crimson-500/20 pt-1.5">
          <span className="font-semibold text-ink">Total Physical Cash Expected in Vehicle</span>
          <span className="font-display text-base font-bold text-crimson-400">R{totalCash}</span>
        </div>
      </div>
    </div>
  );
}

function StopGroupedChecklist({
  riders, touchedIds, onSetPresent, onToggleSponsored, onSetNote, sponsoredIds, notes, disabled,
}: {
  riders: Passenger[];
  touchedIds: Set<string>;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  sponsoredIds: Set<string>;
  notes: Record<string, string>;
  disabled: boolean;
}) {
  const byStop = useMemo(() => passengersByStop(riders), [riders]);
  const stops = sortByRouteSequence(Object.keys(byStop), (s) => s);
  const [expandedStops, setExpandedStops] = useState<Set<string>>(new Set(stops));

  function toggleStop(stop: string) {
    setExpandedStops((prev) => {
      const next = new Set(prev);
      if (next.has(stop)) next.delete(stop);
      else next.add(stop);
      return next;
    });
  }

  function setAllExpanded(expand: boolean) {
    setExpandedStops(expand ? new Set(stops) : new Set());
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {stops.length} stops · {riders.length} passengers
        </span>
        <div className="flex gap-2">
          <button onClick={() => setAllExpanded(true)} className="text-xs text-muted hover:text-ink">Expand all</button>
          <span className="text-muted">·</span>
          <button onClick={() => setAllExpanded(false)} className="text-xs text-muted hover:text-ink">Collapse all</button>
        </div>
      </div>

      {stops.map((stop) => {
        const stopRiders = byStop[stop];
        const stopPresent = stopRiders.filter((r) => r.present).length;
        const stopTouched = stopRiders.filter((r) => touchedIds.has(r.id)).length;
        const isExpanded = expandedStops.has(stop);
        return (
          <div key={stop} className="overflow-hidden rounded-xl border border-line bg-card">
            <button
              onClick={() => toggleStop(stop)}
              className="flex w-full items-center justify-between gap-2 border-b border-line bg-card-2/50 p-3.5 text-left transition-colors hover:bg-card-2/80"
            >
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                <MapPin className="h-4 w-4 text-crimson-400" />
                <span className="text-sm font-semibold text-ink">{stop}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{stopPresent}/{stopRiders.length} present · {stopTouched}/{stopRiders.length} checked</span>
                <span className={`flex h-2 w-2 rounded-full ${stopTouched === stopRiders.length ? 'bg-success' : 'bg-crimson-500'}`} />
              </div>
            </button>

            {isExpanded && (
              <div className="divide-y divide-line/60 animate-fade-in">
                {stopRiders.map((p) => (
                  <PassengerRow
                    key={p.id}
                    passenger={p}
                    touched={touchedIds.has(p.id)}
                    onSetPresent={(present) => onSetPresent(p.id, present)}
                    onToggleSponsored={() => onToggleSponsored(p.id)}
                    onSetNote={(text) => onSetNote(p.id, text)}
                    isSponsored={sponsoredIds.has(p.id)}
                    noteText={notes[p.id] ?? ''}
                    disabled={disabled}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PassengerRow({
  passenger, touched, onSetPresent, onToggleSponsored, onSetNote, isSponsored, noteText, disabled,
}: {
  passenger: Passenger;
  touched: boolean;
  onSetPresent: (present: boolean) => void;
  onToggleSponsored: () => void;
  onSetNote: (text: string) => void;
  isSponsored: boolean;
  noteText: string;
  disabled: boolean;
}) {
  const [showNote, setShowNote] = useState(isSponsored);
  const [note, setNote] = useState(noteText);

  function handleSponsoredToggle() {
    onToggleSponsored();
    if (!isSponsored) setShowNote(true);
  }

  function handleNoteChange(text: string) {
    setNote(text);
    onSetNote(text);
  }

  return (
    <div className={`p-3.5 transition-colors ${disabled ? 'opacity-60' : 'hover:bg-card-2/30'} ${!touched && !disabled ? 'bg-warning/5' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium ${passenger.present ? 'text-success-light' : touched ? 'text-crimson-300' : 'text-ink'}`}>
            {passenger.fullName}
            {passenger.structure && (
              <span className="ml-2 inline-block rounded bg-bg/60 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-muted">
                {passenger.structure}
              </span>
            )}
            {!touched && !disabled && (
              <span className="ml-2 inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                Needs check-in
              </span>
            )}
          </div>
        </div>
        {/* Explicit, side-by-side Present / Absent toggle buttons */}
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => onSetPresent(true)}
            disabled={disabled}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
              passenger.present && touched
                ? 'bg-success/20 text-success-light border border-success/50'
                : 'bg-card-2 text-muted border border-line hover:border-success/40 hover:text-success-light'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Present
            </span>
          </button>
          <button
            onClick={() => onSetPresent(false)}
            disabled={disabled}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
              !passenger.present && touched
                ? 'bg-crimson-500/20 text-crimson-300 border border-crimson-500/50'
                : 'bg-card-2 text-muted border border-line hover:border-crimson-500/40 hover:text-crimson-300'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5" />
              Absent
            </span>
          </button>
        </div>
      </div>

      {/* Sponsored toggle */}
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={handleSponsoredToggle}
          disabled={disabled}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95 ${
            isSponsored
              ? 'bg-warning/15 text-warning border border-warning/40'
              : 'bg-card-2 text-muted border border-line'
          }`}
        >
          <HeartHandshake className="h-3.5 w-3.5" />
          {isSponsored ? 'Sponsored / Didn\'t Pay' : 'Mark Sponsored'}
        </button>
        {isSponsored && (
          <button
            onClick={() => setShowNote(!showNote)}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted border border-line bg-card-2 transition-all hover:text-ink"
          >
            <StickyNote className="h-3.5 w-3.5" />
            {showNote ? 'Hide Note' : 'Add Note'}
          </button>
        )}
      </div>

      {/* Sponsor note — required when sponsored */}
      {isSponsored && showNote && (
        <div className="mt-2 animate-fade-in">
          <input
            type="text"
            value={note}
            onChange={(e) => handleNoteChange(e.target.value)}
            disabled={disabled}
            placeholder="Required: Who is paying for this person? (e.g. Person A in Taxi 1)"
            className="input-field text-xs"
          />
          <p className="mt-1 text-[10px] text-muted">
            This note is included in the stats and cancellation ledger so we know who covers the cost.
          </p>
        </div>
      )}
    </div>
  );
}

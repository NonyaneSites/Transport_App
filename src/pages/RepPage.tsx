import { useMemo, useState } from 'react';
import {
  Bus, Car, CheckCircle2, Circle, Loader2, Users, AlertTriangle,
  Smartphone, Wifi, ChevronDown, ChevronRight, MapPin, Send, Cross,
  HeartHandshake, StickyNote,
} from 'lucide-react';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { useManifest } from '@/lib/useManifest';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey } from '@/lib/dates';
import { SERVICE_TYPES, type ServiceType, type Passenger } from '@/lib/types';
import { vehicleRiders, passengersByStop } from '@/lib/manifest';
import { insertAbsentees } from '@/lib/ledger';

export function RepPage() {
  const [date, setDate] = useState(upcomingSunday);
  const [service, setService] = useState<ServiceType>('PM_Normal');
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);

  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('');
  const [repName, setRepName] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sponsoredIds, setSponsoredIds] = useState<Set<string>>(new Set());
  const [generalNotes, setGeneralNotes] = useState('');

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

  const presentCount = riders.filter((r) => r.present).length;
  const absentCount = riders.length - presentCount;

  // Can only submit if rep name AND license plate are filled
  const sponsoredMissingNotes = riders.some(
    (r) => !r.present && sponsoredIds.has(r.id) && !(notes[r.id] ?? '').trim()
  );
  const canSubmit =
    repName.trim().length > 0 &&
    licensePlate.trim().length > 0 &&
    !sponsoredMissingNotes &&
    !submitting;

  async function togglePresent(passengerId: string) {
    if (!manifest) return;
    const updatedSignups = manifest.signups.map((p) =>
      p.id === passengerId ? { ...p, present: !p.present } : p
    );
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

      // insertAbsentees deduplicates by deleting existing entries for this manifest+vehicle before inserting
      await insertAbsentees(
        key,
        parsedDate,
        serviceLabel,
        absentees,
        selectedVehicle.name,
        repName.trim(),
        licensePlate.trim(),
        repName.trim(),
        generalNotes.trim()
      );

      const updatedVehicles = manifest.vehicles.map((v) =>
        v.id === selectedVehicle.id
          ? {
              ...v,
              submitted: true,
              submittedAt: new Date().toISOString(),
              submittedBy: repName.trim(),
              licensePlate: licensePlate.trim(),
              repName: repName.trim(),
              generalNotes: generalNotes.trim(),
            }
          : v
      );
      await save({ ...manifest, vehicles: updatedVehicles });

      setSubmitMsg(
        `Submitted! ${presentCount} present, ${absentCount} absent. ` +
        `${absentees.length > 0 ? `${absentees.length} absentees added to cancellation ledger. ` : ''}` +
        `Thank you, ${repName.trim()}.`
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
            Pick your allocated taxi or bus, check in passengers by stop, and submit attendance.
            You must enter your name and the vehicle's license plate before submitting.
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
            {/* Vehicle picker */}
            <div className="card">
              <div className="mb-3 flex items-center gap-2">
                <div className="h-5 w-1 rounded-full bg-crimson-500" />
                <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">
                  Select Your Vehicle
                </h2>
              </div>
              <p className="mb-3 text-xs text-muted">
                Pick the taxi or bus the admin assigned you. Each rep handles their own vehicle.
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
                  {manifest.vehicles.map((v) => {
                    const vRiders = vehicleRiders(manifest, v);
                    const vPresent = vRiders.filter((r) => r.present).length;
                    return (
                      <option key={v.id} value={v.id} className="bg-card-2">
                        {v.name} ({v.type}) — {vRiders.length} passengers
                        {v.submitted ? ' ✓ submitted' : ` (${vPresent}/${vRiders.length} checked)`}
                      </option>
                    );
                  })}
                </select>
              </div>

              {selectedVehicleId && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                      Your Name <span className="text-crimson-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={repName}
                      onChange={(e) => setRepName(e.target.value)}
                      placeholder="Required — enter your name"
                      className="input-field"
                    />
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

                <StopGroupedChecklist
                  riders={riders}
                  onToggle={togglePresent}
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
                    {!canSubmit && !sponsoredMissingNotes && (
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

function StopGroupedChecklist({
  riders, onToggle, onToggleSponsored, onSetNote, sponsoredIds, notes, disabled,
}: {
  riders: Passenger[];
  onToggle: (id: string) => void;
  onToggleSponsored: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  sponsoredIds: Set<string>;
  notes: Record<string, string>;
  disabled: boolean;
}) {
  const byStop = useMemo(() => passengersByStop(riders), [riders]);
  const stops = Object.keys(byStop).sort((a, b) => byStop[b].length - byStop[a].length);
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
                <span className="text-xs text-muted">{stopPresent}/{stopRiders.length}</span>
                <span className={`flex h-2 w-2 rounded-full ${stopPresent === stopRiders.length ? 'bg-success' : 'bg-crimson-500'}`} />
              </div>
            </button>

            {isExpanded && (
              <div className="divide-y divide-line/60 animate-fade-in">
                {stopRiders.map((p) => (
                  <PassengerRow
                    key={p.id}
                    passenger={p}
                    onToggle={() => onToggle(p.id)}
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
  passenger, onToggle, onToggleSponsored, onSetNote, isSponsored, noteText, disabled,
}: {
  passenger: Passenger;
  onToggle: () => void;
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
    <div className={`p-3.5 transition-colors ${disabled ? 'opacity-60' : 'hover:bg-card-2/30'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium ${passenger.present ? 'text-success-light' : 'text-ink'}`}>
            {passenger.fullName}
            {passenger.structure && (
              <span className="ml-2 inline-block rounded bg-bg/60 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-muted">
                {passenger.structure}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onToggle}
          disabled={disabled}
          className={`shrink-0 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all active:scale-95 ${
            passenger.present
              ? 'bg-success/15 text-success-light border border-success/40 hover:bg-success/25'
              : 'bg-card-2 text-ink border border-line hover:border-success/40 hover:text-success-light'
          }`}
        >
          {passenger.present ? (
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Present
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Circle className="h-3.5 w-3.5" />
              Mark Present
            </span>
          )}
        </button>
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

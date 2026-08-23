import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Bus, Car, CheckCircle2, XCircle, Loader2, Users, AlertTriangle,
  Smartphone, Wifi, ChevronDown, ChevronRight, MapPin, Send, Cross,
  HeartHandshake, StickyNote, UserPlus, Users2, X, Wallet, Plus, Search, Banknote,
  Sparkles,
} from 'lucide-react';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { useManifest } from '@/lib/useManifest';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey, shortDate } from '@/lib/dates';
import { SERVICE_TYPES, CANCELLATION_FEE, sortByRouteSequence, type ServiceType, type Passenger, type Vehicle, type VehicleDraftState } from '@/lib/types';
import { hubDisplayName } from '@/lib/types';
import { sortVehiclesNatural } from '@/lib/sort';
import { vehicleRiders, passengersByPoolGroup } from '@/lib/manifest';
import { insertAbsentees, withdrawAbsentees, listLedgerEntries, settleLedgerEntries, type LedgerEntry } from '@/lib/ledger';
import { autoSyncGoogleSheetsSilently } from '@/lib/googleSheets';
import { detectVehicleRep, getRepStructure, matchRiderToOfficialRep } from '@/lib/officialReps';
import { RepStatsCopyCard } from '@/components/RepStatsCopyCard';

const FARE = CANCELLATION_FEE; // R40 fixed passenger fare
const SYNC_DEBOUNCE_MS = 300; // 300ms debounce for Supabase background sync

interface ExternalSponsee {
  id: string;
  sponseeName: string;
  taxiName: string;
  amount: number;
}

export interface ManualCancellation {
  id: string;
  passengerName: string;
  structure?: string;
  amount: number;
  note?: string;
}

function makeClientId(): string {
  return `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function RepPage() {
  const [date, setDate] = useState(upcomingSunday);
  const [service, setService] = useState<ServiceType>('PM_Normal');
  const key = manifestKey(date, service);
  const { manifest, loading, error, save } = useManifest(key);

  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(() => {
    try {
      return sessionStorage.getItem(`rep_vehicle_${key}`) || '';
    } catch {
      return '';
    }
  });

  const [repName, setRepName] = useState('');
  const [coReps, setCoReps] = useState<string[]>([]);
  const [licensePlate, setLicensePlate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);

  // Optimistic local state for instantaneous attendance UI
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set());
  const [absentIds, setAbsentIds] = useState<Set<string>>(new Set());
  const [sponsoredIds, setSponsoredIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [generalNotes, setGeneralNotes] = useState('');

  // Cash & sponsorship calculator
  const [externalSponsees, setExternalSponsees] = useState<ExternalSponsee[]>([]);

  // Past-cancellation cash collection & manual cancellation settlement
  const [pastCancellations, setPastCancellations] = useState<LedgerEntry[]>([]);
  const [loadingPastCancellations, setLoadingPastCancellations] = useState(false);
  const [collectedCancellationIds, setCollectedCancellationIds] = useState<Set<string>>(new Set());
  const [manualCancellations, setManualCancellations] = useState<ManualCancellation[]>([]);
  const [cancellationSearch, setCancellationSearch] = useState('');

  // Draft auto-save/restore & sync locks
  const [draftRestored, setDraftRestored] = useState(false);
  const clientIdRef = useRef<string>(makeClientId());
  const pendingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedDraftAtRef = useRef<string | null>(null);
  const isApplyingDraftRef = useRef(false);
  const lastLocalEditTimeRef = useRef<number>(0);
  const initializedKeyRef = useRef<string>('');

  const manifestRef = useRef(manifest);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);

  // Persist selectedVehicleId across refreshes for current manifest key
  useEffect(() => {
    if (selectedVehicleId) {
      try {
        sessionStorage.setItem(`rep_vehicle_${key}`, selectedVehicleId);
      } catch {
        /* storage unavailable */
      }
    }
  }, [key, selectedVehicleId]);

  // Walk-in
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInStructure, setWalkInStructure] = useState('');
  const [transferPrompt, setTransferPrompt] = useState<{ passenger: Passenger; fromVehicle: Vehicle } | null>(null);
  const prevVehicleIdRef = useRef<string | null>(null);

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

  const detectedOfficialRep = useMemo(
    () => riders.length > 0 ? detectVehicleRep(riders) : null,
    [riders]
  );

  const repStructure = repName ? getRepStructure(repName) : null;

  // Prune any IDs that are no longer riders of this vehicle (e.g. moved by admin to another taxi)
  useEffect(() => {
    if (!selectedVehicle) return;
    const currentRiderIdSet = new Set(selectedVehicle.riders);
    setPresentIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (currentRiderIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setAbsentIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (currentRiderIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setSponsoredIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (currentRiderIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedVehicle]);

  // Exact match vehicle when typing rep name if not yet selected (requires exact full name match)
  useEffect(() => {
    if (!manifest || selectedVehicleId) return;
    const q = repName.trim().toLowerCase();
    if (q.length < 3) return;

    const repMatch = matchRiderToOfficialRep({ fullName: repName });

    const match = manifest.vehicles.find((v) => {
      const vRep = (v.repName ?? '').trim().toLowerCase();
      if (vRep) {
        // Strict exact match with assigned rep name or official registered alias
        if (vRep === q) return true;
        if (repMatch && (vRep === repMatch.fullName.toLowerCase() || repMatch.aliases.some((a) => a.toLowerCase() === vRep))) {
          return true;
        }
      }

      // Check if this typed name matches a passenger on board this vehicle EXACTLY
      const vRiders = vehicleRiders(manifest, v);
      for (const r of vRiders) {
        const normRider = r.fullName.trim().toLowerCase();
        if (normRider === q) return true;
        if (repMatch) {
          const rMatch = matchRiderToOfficialRep(r);
          if (rMatch && rMatch.fullName.toLowerCase() === repMatch.fullName.toLowerCase() && normRider === q) {
            return true;
          }
        }
      }
      return false;
    });

    if (match) setSelectedVehicleId(match.id);
  }, [repName, manifest, selectedVehicleId]);

  const resetLocalDraftState = useCallback(() => {
    isApplyingDraftRef.current = true;
    setPresentIds(new Set());
    setAbsentIds(new Set());
    setSponsoredIds(new Set());
    setNotes({});
    setGeneralNotes('');
    setCoReps([]);
    setExternalSponsees([]);
    setCollectedCancellationIds(new Set());
    setManualCancellations([]);
  }, []);

  const applyDraftState = useCallback((draft: VehicleDraftState, vehicleRidersList: Passenger[]) => {
    isApplyingDraftRef.current = true;
    const pIds = new Set(draft.presentIds ?? []);
    const aIds = new Set(draft.absentIds ?? []);

    // Also populate from existing passenger present status if draft is empty
    if (pIds.size === 0 && aIds.size === 0 && vehicleRidersList.length > 0) {
      vehicleRidersList.forEach((r) => {
        if (r.present) pIds.add(r.id);
      });
    }

    setPresentIds(pIds);
    setAbsentIds(aIds);
    setSponsoredIds(new Set(draft.sponsoredIds ?? []));
    setNotes(draft.notes ?? {});
    setGeneralNotes(draft.generalNotes ?? '');
    setCoReps(draft.coReps ?? []);
    setExternalSponsees(draft.externalSponsees ?? []);
    setCollectedCancellationIds(new Set(draft.settledLedgerIds ?? []));
    setManualCancellations(draft.manualCancellations ?? []);
    if (draft.repName !== undefined) setRepName(draft.repName);
    if (draft.licensePlate !== undefined) setLicensePlate(draft.licensePlate);
  }, []);

  // Initialize/restore state when manifest loads or vehicle is selected
  useEffect(() => {
    if (!selectedVehicleId) {
      if (prevVehicleIdRef.current !== null) {
        setWalkInOpen(false);
        setWalkInName('');
        setWalkInStructure('');
        setTransferPrompt(null);
        prevVehicleIdRef.current = null;
      }
      if (initializedKeyRef.current !== '') {
        resetLocalDraftState();
        setDraftRestored(false);
        lastAppliedDraftAtRef.current = null;
        initializedKeyRef.current = '';
      }
      return;
    }

    if (!manifest) return;

    const currentKey = `${key}:${selectedVehicleId}`;
    if (initializedKeyRef.current === currentKey) {
      return;
    }

    // Vehicle selection has changed
    if (prevVehicleIdRef.current !== selectedVehicleId) {
      setWalkInOpen(false);
      setWalkInName('');
      setWalkInStructure('');
      setTransferPrompt(null);
      prevVehicleIdRef.current = selectedVehicleId;
    }

    const vehicle = manifest.vehicles.find((v) => v.id === selectedVehicleId);
    if (!vehicle) return;

    initializedKeyRef.current = currentKey;
    const currentRiders = vehicleRiders(manifest, vehicle);
    const draft = !vehicle.submitted ? vehicle.draftState : undefined;

    if (draft) {
      applyDraftState(draft, currentRiders);
      lastAppliedDraftAtRef.current = draft.updatedAt ?? null;
      setDraftRestored(true);
      const t = setTimeout(() => setDraftRestored(false), 3000);
      return () => clearTimeout(t);
    } else {
      // Default initialization for vehicle
      isApplyingDraftRef.current = true;
      const initialPresent = new Set<string>();
      currentRiders.forEach((r) => {
        if (r.present) initialPresent.add(r.id);
      });
      setPresentIds(initialPresent);
      setAbsentIds(new Set());
      setSponsoredIds(new Set());
      setNotes({});
      setGeneralNotes(vehicle.generalNotes ?? '');
      setCoReps(vehicle.coReps ?? []);
      setExternalSponsees([]);
      setCollectedCancellationIds(new Set());
      setManualCancellations([]);
      if (vehicle.repName) setRepName(vehicle.repName);
      if (vehicle.licensePlate) setLicensePlate(vehicle.licensePlate);
      lastAppliedDraftAtRef.current = null;
    }
  }, [key, manifest, selectedVehicleId, resetLocalDraftState, applyDraftState]);

  // Live cross-device sync (only applies genuine new updates from other devices)
  useEffect(() => {
    if (!selectedVehicle || selectedVehicle.submitted) return;
    const draft = selectedVehicle.draftState;
    if (!draft) return;
    // Ignore updates saved by our own client ID
    if (draft.updatedBy === clientIdRef.current) return;
    // Ignore if we recently made local user edits (within last 2.5 seconds)
    if (Date.now() - lastLocalEditTimeRef.current < 2500) return;
    // Ignore if already applied this exact draft timestamp
    if (draft.updatedAt && draft.updatedAt === lastAppliedDraftAtRef.current) return;

    applyDraftState(draft, riders);
    lastAppliedDraftAtRef.current = draft.updatedAt ?? null;
    setDraftRestored(true);
    const t = setTimeout(() => setDraftRestored(false), 3000);
    return () => clearTimeout(t);
  }, [selectedVehicle?.draftState, selectedVehicle, riders, applyDraftState]);

  // Load past cancellations
  useEffect(() => {
    let mounted = true;
    setLoadingPastCancellations(true);
    (async () => {
      try {
        const entries = await listLedgerEntries();
        if (mounted) setPastCancellations(entries);
      } catch {
        /* Non-critical */
      } finally {
        if (mounted) setLoadingPastCancellations(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Stats calculation
  const presentCount = useMemo(() => {
    return riders.filter((r) => presentIds.has(r.id)).length;
  }, [riders, presentIds]);

  const absentCount = useMemo(() => {
    return riders.filter((r) => absentIds.has(r.id)).length;
  }, [riders, absentIds]);

  const touchedCount = useMemo(() => {
    return riders.filter((r) => presentIds.has(r.id) || absentIds.has(r.id)).length;
  }, [riders, presentIds, absentIds]);

  const allTouched = riders.length > 0 && touchedCount === riders.length;

  const sponsoredMissingNotes = useMemo(() => {
    return riders.some(
      (r) => absentIds.has(r.id) && sponsoredIds.has(r.id) && !(notes[r.id] ?? '').trim()
    );
  }, [riders, absentIds, sponsoredIds, notes]);

  const canSubmit =
    repName.trim().length > 0 &&
    licensePlate.trim().length > 0 &&
    allTouched &&
    !sponsoredMissingNotes &&
    !submitting;

  // Cash calculations
  const presentSponsoredCount = useMemo(() => {
    return riders.filter((r) => presentIds.has(r.id) && sponsoredIds.has(r.id)).length;
  }, [riders, presentIds, sponsoredIds]);

  const grossPresentCash = presentCount * FARE;
  const sponsoredDeduction = presentSponsoredCount * FARE;
  const baseCash = grossPresentCash - sponsoredDeduction;
  const externalCash = externalSponsees.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const selectedLedgerCash = collectedCancellationIds.size * FARE;
  const manualCancellationCash = manualCancellations.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const pastCancellationCash = selectedLedgerCash + manualCancellationCash;
  const totalCash = baseCash + externalCash + pastCancellationCash;

  // 300ms Debounced Supabase Sync
  useEffect(() => {
    if (isApplyingDraftRef.current) {
      isApplyingDraftRef.current = false;
      return;
    }
    if (!selectedVehicleId || !selectedVehicle || selectedVehicle.submitted || !manifestRef.current) return;

    if (pendingSyncTimerRef.current) clearTimeout(pendingSyncTimerRef.current);

    pendingSyncTimerRef.current = setTimeout(() => {
      const currentManifest = manifestRef.current;
      if (!currentManifest) return;

      const pIdsArray = Array.from(presentIds);
      const aIdsArray = Array.from(absentIds);
      const nowIso = new Date().toISOString();

      const draft: VehicleDraftState = {
        presentIds: pIdsArray,
        absentIds: aIdsArray,
        sponsoredIds: Array.from(sponsoredIds),
        notes,
        repName: repName.trim(),
        coReps: coReps.filter(Boolean),
        licensePlate: licensePlate.trim(),
        generalNotes: generalNotes.trim(),
        cashCollected: { base: baseCash, external: externalCash, pastCancellations: pastCancellationCash },
        settledLedgerIds: Array.from(collectedCancellationIds),
        manualCancellations,
        externalSponsees,
        updatedAt: nowIso,
        updatedBy: clientIdRef.current,
      };

      lastAppliedDraftAtRef.current = nowIso;

      // Update vehicle draft and passenger present status optimistically
      const updatedSignups = currentManifest.signups.map((p) => {
        if (presentIds.has(p.id)) return { ...p, present: true };
        if (absentIds.has(p.id)) return { ...p, present: false };
        return p;
      });

      const updatedVehicles = currentManifest.vehicles.map((v) =>
        v.id === selectedVehicleId
          ? {
              ...v,
              repName: repName.trim() || v.repName,
              licensePlate: licensePlate.trim() || v.licensePlate,
              draftState: draft,
            }
          : v
      );

      save({ ...currentManifest, signups: updatedSignups, vehicles: updatedVehicles }).catch(() => {
        /* background sync is best-effort */
      });
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (pendingSyncTimerRef.current) clearTimeout(pendingSyncTimerRef.current);
    };
  }, [
    selectedVehicleId, selectedVehicle, presentIds, absentIds,
    sponsoredIds, notes, generalNotes, coReps, repName, licensePlate,
    externalSponsees, collectedCancellationIds, manualCancellations,
    baseCash, externalCash, pastCancellationCash,
    save
  ]);

  // Instant local toggle handlers (Zero lag, pure React state, deterministic single click)
  const handleSetPresent = useCallback((passengerId: string, wantPresent: boolean) => {
    lastLocalEditTimeRef.current = Date.now();
    if (wantPresent) {
      setPresentIds((prev) => {
        if (prev.has(passengerId)) return prev;
        return new Set(prev).add(passengerId);
      });
      setAbsentIds((prev) => {
        if (!prev.has(passengerId)) return prev;
        const next = new Set(prev);
        next.delete(passengerId);
        return next;
      });
    } else {
      setAbsentIds((prev) => {
        if (!prev.has(passengerId)) return prev;
        return new Set(prev).add(passengerId);
      });
      setPresentIds((prev) => {
        if (!prev.has(passengerId)) return prev;
        const next = new Set(prev);
        next.delete(passengerId);
        return next;
      });
    }
  }, []);

  const handleToggleSponsored = useCallback((passengerId: string) => {
    lastLocalEditTimeRef.current = Date.now();
    setSponsoredIds((prev) => {
      const next = new Set(prev);
      if (next.has(passengerId)) next.delete(passengerId);
      else next.add(passengerId);
      return next;
    });
  }, []);

  const handleSetNote = useCallback((passengerId: string, text: string) => {
    lastLocalEditTimeRef.current = Date.now();
    setNotes((prev) => ({ ...prev, [passengerId]: text }));
  }, []);

  const addCoRep = () => setCoReps((prev) => [...prev, '']);
  const updateCoRep = (index: number, val: string) =>
    setCoReps((prev) => prev.map((c, i) => (i === index ? val : c)));
  const removeCoRep = (index: number) =>
    setCoReps((prev) => prev.filter((_, i) => i !== index));

  const toggleCollectedCancellation = (entryId: string) => {
    setCollectedCancellationIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const addManualCancellation = (initialName?: string) => {
    setManualCancellations((prev) => [
      ...prev,
      {
        id: `canc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        passengerName: initialName || '',
        structure: '',
        amount: FARE,
        note: '',
      },
    ]);
  };

  const updateManualCancellation = (id: string, patch: Partial<ManualCancellation>) => {
    setManualCancellations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeManualCancellation = (id: string) => {
    setManualCancellations((prev) => prev.filter((c) => c.id !== id));
  };

  const addExternalSponsee = () => {
    setExternalSponsees((prev) => [
      ...prev,
      { id: `sponsee-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sponseeName: '', taxiName: '', amount: FARE },
    ]);
  };

  const updateExternalSponsee = (id: string, patch: Partial<ExternalSponsee>) => {
    setExternalSponsees((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeExternalSponsee = (id: string) => {
    setExternalSponsees((prev) => prev.filter((s) => s.id !== id));
  };

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
      const fromVehicle = vehicleFor(existing.assignedTo);
      if (fromVehicle) {
        setTransferPrompt({ passenger: existing, fromVehicle });
        return;
      }
    }

    if (existing) {
      await assignWalkIn(existing, existing.assignedTo);
    } else {
      const newPassenger: Passenger = {
        id: `walkin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fullName: walkInName.trim(),
        stop: 'Walk-In',
        structure: walkInStructure.trim(),
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
      setPresentIds((prev) => new Set(prev).add(newPassenger.id));
    }
    setWalkInName('');
    setWalkInStructure('');
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
        const nextRiders = v.riders.filter((id) => id !== passenger.id);
        const cleanedDraft = v.draftState ? {
          ...v.draftState,
          presentIds: v.draftState.presentIds?.filter((id) => id !== passenger.id),
          absentIds: v.draftState.absentIds?.filter((id) => id !== passenger.id),
          sponsoredIds: v.draftState.sponsoredIds?.filter((id) => id !== passenger.id),
        } : undefined;
        return { ...v, riders: nextRiders, draftState: cleanedDraft };
      }
      if (v.id === selectedVehicle.id) {
        if (v.riders.includes(passenger.id)) return v;
        return { ...v, riders: [...v.riders, passenger.id], orderedStops: orderedStopsWith(v, poolKey) };
      }
      return v;
    });
    await save({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
    setPresentIds((prev) => new Set(prev).add(passenger.id));
  }

  async function confirmTransfer() {
    if (!transferPrompt) return;
    await assignWalkIn(transferPrompt.passenger, transferPrompt.fromVehicle.id);
    setTransferPrompt(null);
    setWalkInName('');
    setWalkInStructure('');
    setWalkInOpen(false);
  }

  async function handleSubmit() {
    if (!manifest || !selectedVehicle) return;
    if (!repName.trim() || !licensePlate.trim()) return;

    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }

    setSubmitting(true);
    setSubmitMsg(null);

    try {
      const absentees = riders
        .filter((r) => absentIds.has(r.id))
        .map((r) => ({
          ...r,
          present: false,
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
      const manualCancSummaries = manualCancellations
        .filter((c) => c.passengerName.trim() || c.amount > 0)
        .map((c) => `${c.passengerName.trim() || 'Anonymous'}${c.structure ? ` (${c.structure.trim()})` : ''} (R${c.amount}${c.note ? ` - ${c.note.trim()}` : ''})`);
      const allSettledInfo = [...settledNames, ...manualCancSummaries];
      const settledNote = allSettledInfo.length > 0
        ? `Past cancellations collected in cash: ${allSettledInfo.join(', ')}. `
        : '';

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

      // Auto-settle ledger entries by selected ID and matching manual passenger names if any
      const matchingLedgerIds = pastCancellations
        .filter((e) => manualCancellations.some((m) => m.passengerName.trim() && m.passengerName.trim().toLowerCase() === e.passenger_name.trim().toLowerCase()))
        .map((e) => e.id);
      const allIdsToSettle = Array.from(new Set([...Array.from(collectedCancellationIds), ...matchingLedgerIds]));

      if (allIdsToSettle.length > 0) {
        await settleLedgerEntries(allIdsToSettle);
        setPastCancellations((prev) => prev.filter((e) => !allIdsToSettle.includes(e.id)));
        setCollectedCancellationIds(new Set());
      }
      setManualCancellations([]);

      const updatedSignups = manifest.signups.map((p) => {
        if (presentIds.has(p.id)) return { ...p, present: true };
        if (absentIds.has(p.id)) return { ...p, present: false };
        return p;
      });

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
              draftState: undefined,
            }
          : v
      );

      await save({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });

      // Automatically sync cancellation ledger to Google Sheets in background
      try {
        await autoSyncGoogleSheetsSilently();
      } catch (sheetErr) {
        console.warn('Sheets auto-sync notice:', sheetErr);
      }

      setSubmitMsg(
        `Submitted! ${presentCount} present, ${absentCount} absent. ` +
        `${absentees.length > 0 ? `${absentees.length} absentee(s) recorded for transport ledger.` : ''} ` +
        `Thank you, ${repDisplayName}.`
      );
    } catch (e) {
      setSubmitMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReopen() {
    if (!manifest || !selectedVehicle) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      // 1. Withdraw absentees for this vehicle from cancellation_ledger
      const vehicleRiderNames = riders.map((r) => r.fullName);
      await withdrawAbsentees(key, vehicleRiderNames);

      // 2. Mark vehicle unsubmitted
      const updatedVehicles = manifest.vehicles.map((v) =>
        v.id === selectedVehicle.id
          ? { ...v, submitted: false, submittedAt: undefined, submittedBy: undefined }
          : v
      );
      await save({ ...manifest, vehicles: updatedVehicles });

      // 3. Immediately re-sync to Google Sheets in background so withdrawn names are removed
      try {
        await autoSyncGoogleSheetsSilently();
      } catch (sheetErr) {
        console.warn('Sheets auto-sync notice on reopen:', sheetErr);
      }

      setSubmitMsg(
        `Attendance reopened for editing. Unconfirmed absentees have been withdrawn from the cancellation ledger until you submit again.`
      );
    } catch (e) {
      setSubmitMsg(`Error reopening: ${e instanceof Error ? e.message : String(e)}`);
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
            Enter your name to find your assigned vehicle, mark every passenger Present or Absent with instant feedback, and submit
            attendance.
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

              <div className="mb-1.5 flex items-center justify-between">
                <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                  Your Name <span className="text-crimson-400">*</span>
                </label>
                {repStructure && (
                  <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px]">
                    Official Structure Rep ({repStructure})
                  </span>
                )}
              </div>

              <input
                type="text"
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                placeholder="Start typing your name…"
                className="input-field mb-1.5"
              />

              {detectedOfficialRep && !repName && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-crimson-500/30 bg-crimson-500/10 px-2.5 py-1.5 text-xs">
                  <span className="flex items-center gap-1.5 text-crimson-300">
                    <Sparkles className="h-3.5 w-3.5 text-crimson-400" />
                    Detected official rep: <strong>{detectedOfficialRep}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setRepName(detectedOfficialRep)}
                    className="text-xs font-bold text-crimson-400 underline hover:text-crimson-300"
                  >
                    Use Name
                  </button>
                </div>
              )}

              {selectedVehicle && repName.trim() && (selectedVehicle.repName ?? '').trim().toLowerCase() === repName.trim().toLowerCase() && (
                <p className="mb-3 flex items-center gap-1 text-xs text-success-light">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Auto-selected {selectedVehicle.name} — you're the assigned rep.
                </p>
              )}

              <p className="mb-3 text-xs text-muted">
                Or pick the taxi or bus the admin assigned you directly:
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
                    return (
                      <option key={v.id} value={v.id} className="bg-card-2">
                        {v.name} — Assigned Rep: {v.repName || 'Unassigned'} ({v.type}) — {vRiders.length} passengers
                        {v.submitted ? ' ✓ submitted' : ''}
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
                🟢 Draft synced with cloud
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
                  <div className="card border-line bg-card">
                    {!walkInOpen ? (
                      <button
                        type="button"
                        onClick={() => setWalkInOpen(true)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-crimson-500/40 bg-crimson-500/5 py-2.5 text-xs font-bold text-crimson-300 hover:bg-crimson-500/10 hover:border-crimson-500 transition-all shadow-sm"
                      >
                        <UserPlus className="h-4 w-4 text-crimson-400" />
                        + Add Walk-In Passenger
                      </button>
                    ) : (
                      <div className="space-y-3 animate-fade-in">
                        <div className="flex items-center justify-between">
                          <label className="block text-xs font-bold uppercase tracking-wide text-ink flex items-center gap-1.5">
                            <UserPlus className="h-3.5 w-3.5 text-crimson-400" />
                            Add Walk-In to {selectedVehicle.name}
                          </label>
                          <button
                            type="button"
                            onClick={() => { setWalkInOpen(false); setWalkInName(''); setWalkInStructure(''); }}
                            className="rounded p-1 text-muted hover:bg-card-2 hover:text-ink text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            type="text"
                            value={walkInName}
                            onChange={(e) => setWalkInName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddWalkIn()}
                            placeholder="Full name (e.g. Sipho Dlamini)"
                            className="input-field text-xs font-medium flex-1"
                            autoFocus
                          />
                          <input
                            type="text"
                            value={walkInStructure}
                            onChange={(e) => setWalkInStructure(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddWalkIn()}
                            placeholder="Structure / FTV (optional, e.g. S3)"
                            className="input-field text-xs sm:w-36"
                          />
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={handleAddWalkIn}
                              disabled={!walkInName.trim()}
                              className="btn-crimson px-3 py-2 text-xs font-bold whitespace-nowrap shadow-sm disabled:opacity-40"
                            >
                              Add Walk-In
                            </button>
                            <button
                              type="button"
                              onClick={() => { setWalkInOpen(false); setWalkInName(''); setWalkInStructure(''); }}
                              className="btn-ghost px-3 py-2 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <StopGroupedChecklist
                  riders={riders}
                  vehicleType={selectedVehicle?.type ?? 'Taxi'}
                  orderedStops={selectedVehicle?.orderedStops}
                  presentIds={presentIds}
                  absentIds={absentIds}
                  onSetPresent={handleSetPresent}
                  onToggleSponsored={handleToggleSponsored}
                  onSetNote={handleSetNote}
                  sponsoredIds={sponsoredIds}
                  notes={notes}
                  disabled={isSubmitted || submitting}
                />

                {/* Rep Stats for Stats Link (Present, FTVs, Sponsorships, Absentees) */}
                <RepStatsCopyCard
                  riders={riders}
                  presentIds={presentIds}
                  absentIds={absentIds}
                  sponsoredIds={sponsoredIds}
                  notes={notes}
                  vehicleName={selectedVehicle.name}
                  repName={repName}
                  isSubmitted={isSubmitted}
                />

                {!isSubmitted && (
                  <>
                    {/* General notes */}
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

                    {/* Cash summary */}
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
                      manualCancellations={manualCancellations}
                      onAddManualCancellation={addManualCancellation}
                      onUpdateManualCancellation={updateManualCancellation}
                      onRemoveManualCancellation={removeManualCancellation}
                      pastCancellationCash={pastCancellationCash}
                      search={cancellationSearch}
                      onSearchChange={setCancellationSearch}
                      baseCash={baseCash}
                      totalCash={totalCash}
                    />

                    {!allTouched && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Every passenger must be marked Present or Absent before you can submit ({touchedCount}/{riders.length} checked).
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
                    className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${
                      submitMsg.startsWith('Error')
                        ? 'border-crimson-500/30 bg-crimson-900/20 text-crimson-300'
                        : 'border-success/30 bg-success/10 text-success-light'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {submitMsg.startsWith('Error') ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                      )}
                      <span className="flex-1">{submitMsg}</span>
                    </div>
                  </div>
                )}

                {isSubmitted && (
                  <button
                    onClick={handleReopen}
                    disabled={submitting}
                    className="btn-ghost w-full text-xs"
                  >
                    {submitting ? (
                      <span className="flex items-center justify-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Reopening…
                      </span>
                    ) : (
                      'Re-open for editing (withdraws unconfirmed absentees)'
                    )}
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
  manualCancellations, onAddManualCancellation, onUpdateManualCancellation, onRemoveManualCancellation,
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
  manualCancellations: ManualCancellation[];
  onAddManualCancellation: (initialName?: string) => void;
  onUpdateManualCancellation: (id: string, patch: Partial<ManualCancellation>) => void;
  onRemoveManualCancellation: (id: string) => void;
  pastCancellationCash: number;
  search: string;
  onSearchChange: (v: string) => void;
  baseCash: number;
  totalCash: number;
}) {
  const q = search.trim().toLowerCase();
  const selectedCancellations = pastCancellations.filter((e) => collectedCancellationIds.has(e.id));
  const searchResults = q.length === 0 ? [] : pastCancellations.filter((e) => {
    if (collectedCancellationIds.has(e.id)) return false;
    return e.passenger_name.toLowerCase().includes(q) || (e.structure || '').toLowerCase().includes(q);
  });
  const totalSettledCount = selectedCancellations.length + manualCancellations.length;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-crimson-400" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Physical Cash Calculator</h2>
        </div>
      </div>

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

      {/* External sponsees */}
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

      {/* Settle past cancellation */}
      <div className="mt-3 border-t border-line/60 pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-crimson-400">
            <Banknote className="h-4 w-4 text-crimson-400" />
            <span>Settle Past Cancellation / Debt (Cash)</span>
            {totalSettledCount > 0 && (
              <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px]">
                {totalSettledCount} settled (+R{pastCancellationCash})
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onAddManualCancellation()}
            className="flex items-center gap-1 rounded-md bg-crimson-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-crimson-500 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            + Add Cancellation Payment
          </button>
        </div>

        {/* Manual cancellation payments list */}
        {manualCancellations.length > 0 && (
          <div className="mb-2.5 space-y-2">
            {manualCancellations.map((c) => (
              <div
                key={c.id}
                className="flex flex-col gap-1.5 rounded-lg border border-crimson-500/30 bg-crimson-500/5 p-2.5 sm:flex-row sm:items-center"
              >
                <input
                  type="text"
                  value={c.passengerName}
                  onChange={(e) => onUpdateManualCancellation(c.id, { passengerName: e.target.value })}
                  placeholder="Passenger Name (e.g. Garainaya Mnisi)"
                  className="input-field py-1.5 text-xs sm:flex-1 font-medium"
                />
                <input
                  type="text"
                  value={c.structure ?? ''}
                  onChange={(e) => onUpdateManualCancellation(c.id, { structure: e.target.value })}
                  placeholder="Structure / Note (optional)"
                  className="input-field py-1.5 text-xs sm:w-44"
                />
                <div className="flex items-center gap-1 text-xs text-muted">
                  R
                  <input
                    type="number"
                    min="0"
                    step="10"
                    value={c.amount}
                    onChange={(e) =>
                      onUpdateManualCancellation(c.id, {
                        amount: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="input-field w-16 py-1 text-center text-xs font-mono font-bold"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveManualCancellation(c.id)}
                  className="rounded-md p-1.5 text-muted hover:bg-crimson-900/30 hover:text-crimson-300"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Selected ledger items */}
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
                  {e.structure && <span className="text-muted"> ({e.structure})</span>}
                </span>
                <button
                  type="button"
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

        {/* Search bar & quick-add */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search ledger by name, or type name to add cancellation payment…"
            className="input-field py-1.5 pl-8 text-xs"
          />
        </div>

        {search.trim().length > 0 && (
          <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-card-2/40 p-2 animate-fade-in">
            {/* Quick-add button for the typed search string */}
            <button
              type="button"
              onClick={() => {
                onAddManualCancellation(search.trim());
                onSearchChange('');
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-dashed border-crimson-500/50 bg-crimson-900/20 px-2.5 py-2 text-left text-xs text-crimson-300 transition-colors hover:bg-crimson-900/40"
            >
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span>Add &ldquo;<strong>{search.trim()}</strong>&rdquo; as cancellation payment</span>
              </span>
              <span className="shrink-0 font-mono font-bold text-xs text-crimson-200">+R{fare}</span>
            </button>

            {loadingPastCancellations ? (
              <p className="py-2 text-center text-[11px] text-muted">Loading ledger entries…</p>
            ) : searchResults.length > 0 ? (
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
            ) : null}
          </div>
        )}

        {pastCancellations.length === 0 && manualCancellations.length === 0 && !loadingPastCancellations && search.trim().length === 0 && (
          <p className="mt-1.5 text-[11px] text-muted">
            Have someone paying a past cancellation fee in cash? Click <strong className="text-crimson-300">+ Add Cancellation Payment</strong> above to include it in the vehicle&apos;s cash calculation.
          </p>
        )}
      </div>

      {/* Live total */}
      <div className="mt-3 space-y-1 rounded-lg border border-crimson-500/20 bg-crimson-900/10 p-3 text-xs">
        <div className="flex items-center justify-between text-muted">
          <span>Base Passenger Cash</span>
          <span className="font-mono font-semibold text-ink">R{baseCash}</span>
        </div>
        {externalCash > 0 && (
          <div className="flex items-center justify-between text-muted">
            <span>+ External Sponsee Cash</span>
            <span className="font-mono font-semibold text-ink">R{externalCash}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-muted">
          <span>+ Past Cancellation Cash Settled</span>
          <span className="font-mono font-semibold text-ink">
            R{pastCancellationCash}
            {totalSettledCount > 0 && (
              <span className="text-[10px] text-muted ml-1">({totalSettledCount} person{totalSettledCount > 1 ? 's' : ''})</span>
            )}
          </span>
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
  riders, vehicleType, orderedStops, presentIds, absentIds, onSetPresent, onToggleSponsored, onSetNote, sponsoredIds, notes, disabled,
}: {
  riders: Passenger[];
  vehicleType: 'Bus' | 'Taxi';
  orderedStops?: string[];
  presentIds: Set<string>;
  absentIds: Set<string>;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  sponsoredIds: Set<string>;
  notes: Record<string, string>;
  disabled: boolean;
}) {
  const byStop = useMemo(() => passengersByPoolGroup(riders, vehicleType), [riders, vehicleType]);
  const stops = useMemo(() => {
    const activeKeys = Object.keys(byStop);
    if (!orderedStops || orderedStops.length === 0) {
      return sortByRouteSequence(activeKeys, (s) => s);
    }
    const inOrder = orderedStops.filter((s) => activeKeys.includes(s));
    const extras = activeKeys.filter((s) => !inOrder.includes(s));
    return [...inOrder, ...extras];
  }, [byStop, orderedStops]);
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
        const stopPresent = stopRiders.filter((r) => presentIds.has(r.id)).length;
        const stopTouched = stopRiders.filter((r) => presentIds.has(r.id) || absentIds.has(r.id)).length;
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
                    isPresent={presentIds.has(p.id)}
                    isAbsent={absentIds.has(p.id)}
                    touched={presentIds.has(p.id) || absentIds.has(p.id)}
                    onSetPresent={onSetPresent}
                    onToggleSponsored={onToggleSponsored}
                    onSetNote={onSetNote}
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

const PassengerRow = React.memo(function PassengerRow({
  passenger, isPresent, isAbsent, touched, onSetPresent, onToggleSponsored, onSetNote, isSponsored, noteText, disabled,
}: {
  passenger: Passenger;
  isPresent: boolean;
  isAbsent: boolean;
  touched: boolean;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  isSponsored: boolean;
  noteText: string;
  disabled: boolean;
}) {
  const [showNote, setShowNote] = useState(isSponsored);

  function handleSponsoredToggle() {
    onToggleSponsored(passenger.id);
    if (!isSponsored) setShowNote(true);
  }

  return (
    <div className={`p-3.5 transition-colors ${disabled ? 'opacity-60' : 'hover:bg-card-2/30'} ${!touched && !disabled ? 'bg-warning/5' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium ${isPresent ? 'text-success-light' : isAbsent ? 'text-crimson-300' : 'text-ink'}`}>
            {passenger.fullName}
            {passenger.structure && (
              <span className="ml-2 inline-block rounded bg-bg/60 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-muted">
                {passenger.structure}
              </span>
            )}
            {passenger.category === 'Ushers' && (
              <span className="ml-1.5 inline-block rounded bg-amber-500/15 text-amber-300 px-1.5 py-0.5 text-[10px] font-semibold">
                Usher (Early)
              </span>
            )}
            {passenger.category === 'Normal' && (
              <span className="ml-1.5 inline-block rounded bg-sky-500/15 text-sky-300 px-1.5 py-0.5 text-[10px]">
                Normal
              </span>
            )}
            {passenger.stop && (
              <span className="ml-1.5 inline-block rounded bg-bg/60 px-1.5 py-0.5 text-[10px] text-muted">
                {passenger.stop}
              </span>
            )}
            {!touched && !disabled && (
              <span className="ml-2 inline-block rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                Needs check-in
              </span>
            )}
          </div>
        </div>

        {/* Optimistic Instant Present / Absent Buttons */}
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => onSetPresent(passenger.id, true)}
            disabled={disabled}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
              isPresent
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
            type="button"
            onClick={() => onSetPresent(passenger.id, false)}
            disabled={disabled}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
              isAbsent
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
          type="button"
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
            type="button"
            onClick={() => setShowNote(!showNote)}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted border border-line bg-card-2 transition-all hover:text-ink"
          >
            <StickyNote className="h-3.5 w-3.5" />
            {showNote ? 'Hide Note' : 'Add Note'}
          </button>
        )}
      </div>

      {/* Sponsor note input */}
      {isSponsored && showNote && (
        <div className="mt-2 animate-fade-in">
          <input
            type="text"
            value={noteText}
            onChange={(e) => onSetNote(passenger.id, e.target.value)}
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
});

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Bus, Car, CheckCircle2, XCircle, Loader2, Users, AlertTriangle,
  Smartphone, ChevronDown, ChevronRight, MapPin, Send,
  HeartHandshake, StickyNote, UserPlus, Users2, X, Wallet, Plus, Search, Banknote,
  Sparkles, ArrowDownAZ, RotateCcw, Check, AlertCircle, Calendar,
} from 'lucide-react';
import { ServiceDateSelector } from '@/components/ServiceDateSelector';
import { useManifest } from '@/lib/useManifest';
import { upcomingSunday, manifestKey, prettyDate, parseManifestKey, shortDate } from '@/lib/dates';
import {
  SERVICE_TYPES,
  CANCELLATION_FEE,
  sortByRouteSequence,
  type ServiceType,
  type Passenger,
  type Vehicle,
  type VehicleDraftState,
  type LiveSyncAction,
} from '@/lib/types';
import { hubDisplayName, getEffectiveStop, getPassengerStatusBadge } from '@/lib/types';
import { sortVehiclesNatural, naturalCompare } from '@/lib/sort';
import { vehicleRiders } from '@/lib/manifest';
import { insertAbsentees, withdrawAbsentees, listLedgerEntries, settleLedgerEntries, extractServiceCode, type LedgerEntry } from '@/lib/ledger';
import { detectVehicleRep, getRepStructure, matchRiderToOfficialRep } from '@/lib/officialReps';
import { RepStatsCopyCard } from '@/components/RepStatsCopyCard';
import { CancellationSearchModal } from '@/components/CancellationSearchModal';
import {
  transferPassengerAcrossServices,
  crossCheckPassengerAcrossDate,
  isPassengerTransferMatch,
  extractStructureFromText,
} from '@/lib/transfer';
import {
  toggleRiderSponsoredInFirestore,
  toggleRiderUnpaidInFirestore,
  setRiderAttendanceInFirestore,
} from '@/lib/firebase';

const FARE = CANCELLATION_FEE; // R40 fixed passenger fare
const SYNC_DEBOUNCE_MS = 500; // 500ms debounce: ultra-fast multi-device synchronization while batching bursts of taps

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
  return `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function RepPage() {
  const [date, setDate] = useState(() => {
    try {
      const stored = localStorage.getItem('crc_rep_selected_date');
      if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored.trim())) {
        return stored.trim();
      }
      return upcomingSunday();
    } catch {
      return upcomingSunday();
    }
  });
  const [service, setService] = useState<ServiceType>(() => {
    try {
      return (localStorage.getItem('crc_rep_selected_service') as ServiceType) || 'PM_Normal';
    } catch {
      return 'PM_Normal';
    }
  });
  const key = manifestKey(date, service);

  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(() => {
    try {
      return localStorage.getItem(`crc_rep_vehicle_${key}`) || '';
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
  const [unpaidIds, setUnpaidIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [generalNotes, setGeneralNotes] = useState('');

  // Concurrency tracking
  const licensePlateFocusedRef = useRef(false);
  const generalNotesFocusedRef = useRef(false);
  const clientIdRef = useRef<string>(makeClientId());
  const recentlyEditedRidersRef = useRef<Map<string, number>>(new Map());

  const handleLiveActionReceived = useCallback((action: LiveSyncAction) => {
    if (action.clientId === clientIdRef.current) return;

    if (action.vehicleId === selectedVehicleId) {
      if (action.type === 'rider_attendance') {
        const { riderId, status } = action;
        const now = Date.now();
        const lastEdit = recentlyEditedRidersRef.current.get(riderId) ?? 0;
        if (now - lastEdit > 1500) {
          if (status === 'present') {
            setPresentIds((prev) => new Set(prev).add(riderId));
            setAbsentIds((prev) => {
              const next = new Set(prev);
              next.delete(riderId);
              return next;
            });
          } else if (status === 'absent') {
            setAbsentIds((prev) => new Set(prev).add(riderId));
            setPresentIds((prev) => {
              const next = new Set(prev);
              next.delete(riderId);
              return next;
            });
          } else {
            setPresentIds((prev) => {
              const next = new Set(prev);
              next.delete(riderId);
              return next;
            });
            setAbsentIds((prev) => {
              const next = new Set(prev);
              next.delete(riderId);
              return next;
            });
          }
        }
      } else if (action.type === 'rider_sponsored') {
        const { riderId, sponsored } = action;
        setSponsoredIds((prev) => {
          const next = new Set(prev);
          if (sponsored) next.add(riderId);
          else next.delete(riderId);
          return next;
        });
      } else if (action.type === 'rider_unpaid') {
        const { riderId, unpaid } = action;
        setUnpaidIds((prev) => {
          const next = new Set(prev);
          if (unpaid) next.add(riderId);
          else next.delete(riderId);
          return next;
        });
      } else if (action.type === 'rider_note') {
        const { riderId, note } = action;
        setNotes((prev) => ({ ...prev, [riderId]: note }));
      } else if (action.type === 'metadata_change') {
        if (action.licensePlate && !licensePlateFocusedRef.current) {
          setLicensePlate(action.licensePlate);
        }
        if (action.generalNotes && !generalNotesFocusedRef.current) {
          setGeneralNotes(action.generalNotes);
        }
      }
    }
  }, [selectedVehicleId]);

  const {
    manifest,
    loading,
    error,
    isSyncing,
    refresh,
    save,
    updateVehicleDraft,
    appendWalkIn,
    broadcastLiveAction,
  } = useManifest(key, selectedVehicleId, handleLiveActionReceived);

  // Rider search, filtering, and view mode for person-by-person check-in
  const [riderSearch, setRiderSearch] = useState('');
  const [riderFilter, setRiderFilter] = useState<'all' | 'unticked' | 'present' | 'absent'>('all');
  const [viewMode, setViewMode] = useState<'stop' | 'alpha'>('stop');
  const [batchActionMsg, setBatchActionMsg] = useState<string | null>(null);

  // Cash & sponsorship calculator
  const [externalSponsees, setExternalSponsees] = useState<ExternalSponsee[]>([]);

  // Past-cancellation cash collection & manual cancellation settlement
  const [pastCancellations, setPastCancellations] = useState<LedgerEntry[]>([]);
  const [loadingPastCancellations, setLoadingPastCancellations] = useState(false);
  const [hasLoadedPastCancellations, setHasLoadedPastCancellations] = useState(false);
  const [collectedCancellationIds, setCollectedCancellationIds] = useState<Set<string>>(new Set());
  const [manualCancellations, setManualCancellations] = useState<ManualCancellation[]>([]);
  const [cancellationSearch, setCancellationSearch] = useState('');
  const [showCancellationModal, setShowCancellationModal] = useState(false);

  // Sync locks & conflict prevention
  const [draftRestored, setDraftRestored] = useState(false);
  const pendingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedDraftAtRef = useRef<string | null>(null);
  const isApplyingDraftRef = useRef(false);
  const isUserDirtyRef = useRef(false);
  const lastLocalEditTimeRef = useRef<number>(0);
  const initializedKeyRef = useRef<string>('');
  const prevVehicleSubmittedRef = useRef<boolean | undefined>(undefined);

  // Periodic presence heartbeat: keeps co-reps aware of each other
  useEffect(() => {
    if (!selectedVehicleId) return;
    broadcastLiveAction({
      type: 'presence_heartbeat',
      vehicleId: selectedVehicleId,
      repName: repName.trim() || 'Co-rep',
      clientId: clientIdRef.current,
      timestamp: Date.now(),
    });

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      broadcastLiveAction({
        type: 'presence_heartbeat',
        vehicleId: selectedVehicleId,
        repName: repName.trim() || 'Co-rep',
        clientId: clientIdRef.current,
        timestamp: Date.now(),
      });
    }, 7000);

    return () => clearInterval(interval);
  }, [selectedVehicleId, repName, broadcastLiveAction]);

  const manifestRef = useRef(manifest);
  useEffect(() => { manifestRef.current = manifest; }, [manifest]);

  // Persist session preferences to localStorage so closing/refreshing never loses context
  useEffect(() => {
    try {
      localStorage.setItem('crc_rep_selected_date', date);
    } catch {
      // storage unavailable
    }
  }, [date]);

  useEffect(() => {
    try {
      localStorage.setItem('crc_rep_selected_service', service);
    } catch {
      // storage unavailable
    }
  }, [service]);

  useEffect(() => {
    if (selectedVehicleId) {
      try {
        localStorage.setItem(`crc_rep_vehicle_${key}`, selectedVehicleId);
      } catch {
        // storage unavailable
      }
    }
  }, [key, selectedVehicleId]);

  useEffect(() => {
    if (repName) {
      try {
        localStorage.setItem('crc_rep_name', repName);
      } catch {
        // storage unavailable
      }
    }
  }, [repName]);

  // Walk-in & Cross-Service Transfer
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInStructure, setWalkInStructure] = useState('');
  const [transferPrompt, setTransferPrompt] = useState<{
    passenger: Passenger;
    fromVehicle?: Vehicle | null;
    fromService: ServiceType;
    fromServiceLabel: string;
    isCrossService: boolean;
    isCompatible: boolean;
    incompatibleReason?: string;
    statusDescription: string;
  } | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [isCheckingCrossService, setIsCheckingCrossService] = useState(false);
  const prevVehicleIdRef = useRef<string | null>(null);

  const serviceLabel = SERVICE_TYPES.find((s) => s.value === service)?.label ?? service;
  const { date: parsedDate } = parseManifestKey(key);

  const selectedVehicle = useMemo(
    () => manifest?.vehicles.find((v) => v.id === selectedVehicleId) ?? null,
    [manifest, selectedVehicleId]
  );

  const riders = useMemo(
    () => (selectedVehicle ? vehicleRiders(manifest, selectedVehicle) : []),
    [manifest, selectedVehicle]
  );

  const detectedOfficialRep = useMemo(
    () => (riders.length > 0 ? detectVehicleRep(riders) : null),
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
    setUnpaidIds((prev) => {
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
        if (vRep === q) return true;
        if (repMatch && (vRep === repMatch.fullName.toLowerCase() || repMatch.aliases.some((a) => a.toLowerCase() === vRep))) {
          return true;
        }
      }

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
    isUserDirtyRef.current = false;
    setPresentIds(new Set());
    setAbsentIds(new Set());
    setSponsoredIds(new Set());
    setUnpaidIds(new Set());
    setNotes({});
    setGeneralNotes('');
    setCoReps([]);
    setExternalSponsees([]);
    setCollectedCancellationIds(new Set());
    setManualCancellations([]);
    setRepName('');
    setLicensePlate('');
  }, []);

  // When session key (date or service) changes, update vehicle selection to the stored vehicle for that session,
  // or clear selection and reset draft state so vehicles and drafts from previous dates never bleed over
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`crc_rep_vehicle_${key}`);
      setSelectedVehicleId(stored || '');
    } catch {
      setSelectedVehicleId('');
    }
    resetLocalDraftState();
  }, [key, resetLocalDraftState]);

  // When manifest loads or changes, if the selected vehicle does not exist in the manifest, reset vehicle selection
  useEffect(() => {
    if (!manifest || manifest.date !== key) return;
    if (selectedVehicleId && !manifest.vehicles.some((v) => v.id === selectedVehicleId)) {
      setSelectedVehicleId('');
      resetLocalDraftState();
    }
  }, [manifest, key, selectedVehicleId, resetLocalDraftState]);

  const applyDraftState = useCallback((draft: VehicleDraftState, vehicleRidersList: Passenger[], fallbackVehicle?: Vehicle | null) => {
    isApplyingDraftRef.current = true;
    const pIds = new Set(draft.presentIds ?? []);
    const aIds = new Set(draft.absentIds ?? []);

    // Also populate from existing passenger present status if draft is empty
    if (pIds.size === 0 && aIds.size === 0 && vehicleRidersList.length > 0) {
      vehicleRidersList.forEach((r) => {
        if (r.present) {
          pIds.add(r.id);
        } else if (fallbackVehicle?.submitted) {
          aIds.add(r.id);
        }
      });
    }

    setPresentIds(pIds);
    setAbsentIds(aIds);
    setSponsoredIds(new Set(draft.sponsoredIds ?? []));
    setUnpaidIds(new Set(draft.unpaidIds ?? []));
    setNotes(draft.notes ?? {});
    setGeneralNotes(draft.generalNotes ?? fallbackVehicle?.generalNotes ?? '');
    setCoReps(draft.coReps ?? fallbackVehicle?.coReps ?? []);
    setExternalSponsees(draft.externalSponsees ?? []);
    setCollectedCancellationIds(new Set(draft.settledLedgerIds ?? []));
    setManualCancellations(draft.manualCancellations ?? []);
    setRepName(draft.repName !== undefined ? draft.repName : (fallbackVehicle?.repName || ''));
    setLicensePlate(draft.licensePlate !== undefined ? draft.licensePlate : (fallbackVehicle?.licensePlate || ''));
  }, []);

  /**
   * Conflict-free merge of remote draft states from other devices/reps:
   * 1. Preserves riders that the local rep touched recently (<1500ms).
   * 2. Seamlessly brings in remote check-ins (present/absent) without overwriting ongoing local work.
   * 3. Merges notes, sponsorships, unpaid flags, co-reps, and cancellation collections.
   */
  const mergeRemoteDraftState = useCallback((draft: VehicleDraftState, vehicleRidersList: Passenger[]) => {
    isApplyingDraftRef.current = true;
    const now = Date.now();

    // 1. Merge Present and Absent IDs without overriding riders the local user clicked in the last 3500ms
    setPresentIds((prevPresent) => {
      const nextPresent = new Set(prevPresent);
      const remotePresent = new Set(draft.presentIds ?? []);
      const remoteAbsent = new Set(draft.absentIds ?? []);

      for (const rider of vehicleRidersList) {
        const lastEdit = recentlyEditedRidersRef.current.get(rider.id) ?? 0;
        if (now - lastEdit < 600) {
          // Local user explicitly touched this rider within the last 600ms — keep local action in flight
          continue;
        }
        if (remotePresent.has(rider.id)) {
          nextPresent.add(rider.id);
        } else if (remoteAbsent.has(rider.id)) {
          nextPresent.delete(rider.id);
        }
      }
      return nextPresent;
    });

    setAbsentIds((prevAbsent) => {
      const nextAbsent = new Set(prevAbsent);
      const remotePresent = new Set(draft.presentIds ?? []);
      const remoteAbsent = new Set(draft.absentIds ?? []);

      for (const rider of vehicleRidersList) {
        const lastEdit = recentlyEditedRidersRef.current.get(rider.id) ?? 0;
        if (now - lastEdit < 600) {
          // Local user explicitly touched this rider within the last 600ms — keep local action in flight
          continue;
        }
        if (remoteAbsent.has(rider.id)) {
          nextAbsent.add(rider.id);
        } else if (remotePresent.has(rider.id)) {
          nextAbsent.delete(rider.id);
        }
      }
      return nextAbsent;
    });

    // 2. Direct synchronization of sponsored and unpaid statuses across all co-reps (turning on and off)
    if (draft.sponsoredIds !== undefined) {
      const remoteSponsored = new Set(draft.sponsoredIds);
      setSponsoredIds((prev) => {
        const next = new Set<string>(remoteSponsored);
        // Retain optimistic local tap only if touched in the last 600ms
        for (const id of prev) {
          const lastEdit = recentlyEditedRidersRef.current.get(id) ?? 0;
          if (now - lastEdit < 600 && !remoteSponsored.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
    }

    if (draft.unpaidIds !== undefined) {
      const remoteUnpaid = new Set(draft.unpaidIds);
      setUnpaidIds((prev) => {
        const next = new Set<string>(remoteUnpaid);
        // Retain optimistic local tap only if touched in the last 600ms
        for (const id of prev) {
          const lastEdit = recentlyEditedRidersRef.current.get(id) ?? 0;
          if (now - lastEdit < 600 && !remoteUnpaid.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
    }

    if (draft.notes) {
      setNotes((prev) => ({ ...draft.notes, ...prev }));
    }

    // 3. Vehicle metadata fields (repName, licensePlate, generalNotes)
    if (draft.repName && !repName.trim()) {
      setRepName(draft.repName);
    }
    if (draft.licensePlate && !licensePlate.trim()) {
      setLicensePlate(draft.licensePlate);
    }
    if (draft.generalNotes && !generalNotes.trim()) {
      setGeneralNotes(draft.generalNotes);
    }

    // 4. Co-reps, sponsees, cancellations
    if (draft.coReps && draft.coReps.length > 0) {
      setCoReps((prev) => Array.from(new Set([...prev, ...(draft.coReps || [])])).filter(Boolean));
    }
    if (draft.externalSponsees && draft.externalSponsees.length > 0) {
      setExternalSponsees(draft.externalSponsees);
    }
    if (draft.settledLedgerIds) {
      setCollectedCancellationIds(new Set(draft.settledLedgerIds));
    }
    if (draft.manualCancellations) {
      setManualCancellations(draft.manualCancellations);
    }
  }, [repName, licensePlate, generalNotes]);

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

    // Retrieve local device draft cache if any (for instant recovery if refreshed or browser closed)
    let localDraft: VehicleDraftState | null = null;
    try {
      const raw = localStorage.getItem(`crc_rep_draft_${key}_${selectedVehicleId}`);
      if (raw) localDraft = JSON.parse(raw);
    } catch {
      localDraft = null;
    }

    const cloudDraft = vehicle.draftState;

    // Pick whichever draft has the freshest edits
    let draft: VehicleDraftState | undefined = undefined;
    if (localDraft && cloudDraft) {
      const localTime = localDraft.updatedAt ? new Date(localDraft.updatedAt).getTime() : 0;
      const cloudTime = cloudDraft.updatedAt ? new Date(cloudDraft.updatedAt).getTime() : 0;
      draft = localTime >= cloudTime ? localDraft : cloudDraft;
    } else if (localDraft) {
      draft = localDraft;
    } else if (cloudDraft) {
      draft = cloudDraft;
    }

    if (draft) {
      applyDraftState(draft, currentRiders, vehicle);
      lastAppliedDraftAtRef.current = draft.updatedAt ?? null;
      setDraftRestored(true);
      const t = setTimeout(() => setDraftRestored(false), 2500);
      return () => clearTimeout(t);
    } else {
      isApplyingDraftRef.current = true;
      const initialPresent = new Set<string>();
      const initialAbsent = new Set<string>();
      const initialSponsored = new Set<string>();
      const initialUnpaid = new Set<string>();
      currentRiders.forEach((r) => {
        if (r.present) {
          initialPresent.add(r.id);
        } else if (vehicle.submitted) {
          initialAbsent.add(r.id);
        }
        if (r.sponsored) {
          initialSponsored.add(r.id);
        }
        if (r.didNotPay) {
          initialUnpaid.add(r.id);
        }
      });
      setPresentIds(initialPresent);
      setAbsentIds(initialAbsent);
      setSponsoredIds(initialSponsored);
      setUnpaidIds(initialUnpaid);
      setNotes({});
      setGeneralNotes(vehicle.generalNotes ?? '');
      setCoReps(vehicle.coReps ?? []);
      setExternalSponsees([]);
      setCollectedCancellationIds(new Set());
      setManualCancellations([]);
      setRepName(vehicle.repName || '');
      setLicensePlate(vehicle.licensePlate || '');
      lastAppliedDraftAtRef.current = null;
    }
  }, [key, manifest, selectedVehicleId, resetLocalDraftState, applyDraftState]);

  // Live cross-device sync (only applies genuine new updates from other devices)
  useEffect(() => {
    if (!selectedVehicle) return;
    const draft = selectedVehicle.draftState;
    if (!draft) return;
    if (draft.updatedBy === clientIdRef.current) return;
    if (draft.updatedAt && draft.updatedAt === lastAppliedDraftAtRef.current) return;

    mergeRemoteDraftState(draft, riders);
    lastAppliedDraftAtRef.current = draft.updatedAt ?? null;
  }, [selectedVehicle?.draftState, selectedVehicle, riders, mergeRemoteDraftState]);

  // Sync submission status changes from other devices / admin in real time
  useEffect(() => {
    if (!selectedVehicle) return;
    if (prevVehicleSubmittedRef.current !== undefined && prevVehicleSubmittedRef.current !== selectedVehicle.submitted) {
      prevVehicleSubmittedRef.current = selectedVehicle.submitted;
      if (selectedVehicle.submitted && selectedVehicle.draftState) {
        applyDraftState(selectedVehicle.draftState, riders, selectedVehicle);
      }
    } else {
      prevVehicleSubmittedRef.current = selectedVehicle.submitted;
    }
  }, [selectedVehicle?.submitted, selectedVehicle?.draftState, selectedVehicle, riders, applyDraftState]);

  // Load past cancellations so reps have instant live search of church debtors
  const ensurePastCancellationsLoaded = useCallback(async () => {
    if (hasLoadedPastCancellations || loadingPastCancellations) return;
    setLoadingPastCancellations(true);
    try {
      const entries = await listLedgerEntries();
      setPastCancellations(entries);
      setHasLoadedPastCancellations(true);
    } catch {
      /* non-critical */
    } finally {
      setLoadingPastCancellations(false);
    }
  }, [hasLoadedPastCancellations, loadingPastCancellations]);

  // Eagerly prefetch past cancellation ledger when vehicle is selected
  useEffect(() => {
    ensurePastCancellationsLoaded();
  }, [ensurePastCancellationsLoaded, selectedVehicleId]);

  // Map each rider in the current vehicle to any unpaid debt entries in the cancellation ledger
  const riderDebtsMap = useMemo(() => {
    const map: Record<string, LedgerEntry[]> = {};
    if (!pastCancellations || pastCancellations.length === 0) return map;
    for (const r of riders) {
      const norm = r.fullName.trim().toLowerCase();
      const matches = pastCancellations.filter((e) => e.passenger_name.trim().toLowerCase() === norm);
      if (matches.length > 0) {
        map[r.id] = matches;
      }
    }
    return map;
  }, [riders, pastCancellations]);

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

  const untickedCount = useMemo(() => {
    return Math.max(0, riders.length - touchedCount);
  }, [riders.length, touchedCount]);

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
  const selectedLedgerCash = useMemo(() => {
    return pastCancellations
      .filter((e) => collectedCancellationIds.has(e.id))
      .reduce((sum, e) => sum + (Number(e.structure_debt) || FARE), 0);
  }, [pastCancellations, collectedCancellationIds]);
  const manualCancellationCash = manualCancellations.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const pastCancellationCash = selectedLedgerCash + manualCancellationCash;
  const totalCash = baseCash + externalCash + pastCancellationCash;

  // Conflict-Safe Debounced Background Sync & Instant Local Cache
  useEffect(() => {
    if (isApplyingDraftRef.current) {
      isApplyingDraftRef.current = false;
      return;
    }
    if (!selectedVehicleId || !selectedVehicle || selectedVehicle.submitted || !isUserDirtyRef.current) {
      return;
    }

    const pIdsArray = Array.from(presentIds);
    const aIdsArray = Array.from(absentIds);
    const nowIso = new Date().toISOString();

    const currentDraft: VehicleDraftState = {
      presentIds: pIdsArray,
      absentIds: aIdsArray,
      sponsoredIds: Array.from(sponsoredIds),
      unpaidIds: Array.from(unpaidIds),
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

    // 1. Synchronously cache draft on device (Zero loss on crash, refresh, phone lock, tab exit)
    try {
      localStorage.setItem(`crc_rep_draft_${key}_${selectedVehicleId}`, JSON.stringify(currentDraft));
    } catch {
      // storage unavailable
    }

    // 2. Debounced background cloud sync to Supabase
    if (pendingSyncTimerRef.current) clearTimeout(pendingSyncTimerRef.current);

    pendingSyncTimerRef.current = setTimeout(() => {
      if (!isUserDirtyRef.current) return;
      isUserDirtyRef.current = false;

      lastAppliedDraftAtRef.current = nowIso;

      updateVehicleDraft(
        selectedVehicleId,
        currentDraft,
        repName.trim(),
        licensePlate.trim(),
        pIdsArray,
        aIdsArray
      ).catch((err) => {
        console.warn('Background sync note:', err);
      });
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (pendingSyncTimerRef.current) clearTimeout(pendingSyncTimerRef.current);
    };
  }, [
    selectedVehicleId, selectedVehicle, presentIds, absentIds,
    sponsoredIds, unpaidIds, notes, generalNotes, coReps, repName, licensePlate,
    externalSponsees, collectedCancellationIds, manualCancellations,
    baseCash, externalCash, pastCancellationCash,
    key, updateVehicleDraft,
  ]);

  // Lifecycle listeners: Flush draft on unexpected tab close, refresh, or mobile app switch
  useEffect(() => {
    const handleFlushOnExit = () => {
      if (!selectedVehicleId || !selectedVehicle || selectedVehicle.submitted || !isUserDirtyRef.current) return;
      const currentDraft: VehicleDraftState = {
        presentIds: Array.from(presentIds),
        absentIds: Array.from(absentIds),
        sponsoredIds: Array.from(sponsoredIds),
        unpaidIds: Array.from(unpaidIds),
        notes,
        repName: repName.trim(),
        coReps: coReps.filter(Boolean),
        licensePlate: licensePlate.trim(),
        generalNotes: generalNotes.trim(),
        cashCollected: { base: baseCash, external: externalCash, pastCancellations: pastCancellationCash },
        settledLedgerIds: Array.from(collectedCancellationIds),
        manualCancellations,
        externalSponsees,
        updatedAt: new Date().toISOString(),
        updatedBy: clientIdRef.current,
      };
      try {
        localStorage.setItem(`crc_rep_draft_${key}_${selectedVehicleId}`, JSON.stringify(currentDraft));
      } catch {
        // storage unavailable
      }
    };

    window.addEventListener('beforeunload', handleFlushOnExit);
    window.addEventListener('pagehide', handleFlushOnExit);
    document.addEventListener('visibilitychange', handleFlushOnExit);

    return () => {
      window.removeEventListener('beforeunload', handleFlushOnExit);
      window.removeEventListener('pagehide', handleFlushOnExit);
      document.removeEventListener('visibilitychange', handleFlushOnExit);
    };
  }, [
    selectedVehicleId, selectedVehicle, presentIds, absentIds,
    sponsoredIds, unpaidIds, notes, generalNotes, coReps, repName, licensePlate,
    externalSponsees, collectedCancellationIds, manualCancellations,
    baseCash, externalCash, pastCancellationCash, key,
  ]);

  // Instant local toggle handlers (Zero lag, pure React state, deterministic single click)
  const handleSetPresent = useCallback((passengerId: string, wantPresent: boolean) => {
    lastLocalEditTimeRef.current = Date.now();
    recentlyEditedRidersRef.current.set(passengerId, Date.now());
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
        if (prev.has(passengerId)) return prev;
        return new Set(prev).add(passengerId);
      });
      setPresentIds((prev) => {
        if (!prev.has(passengerId)) return prev;
        const next = new Set(prev);
        next.delete(passengerId);
        return next;
      });
    }

    if (selectedVehicleId) {
      broadcastLiveAction({
        type: 'rider_attendance',
        vehicleId: selectedVehicleId,
        riderId: passengerId,
        status: wantPresent ? 'present' : 'absent',
        repName: repName.trim() || 'Co-rep',
        clientId: clientIdRef.current,
        timestamp: Date.now(),
      });
      if (key) {
        setRiderAttendanceInFirestore(
          key,
          selectedVehicleId,
          passengerId,
          wantPresent ? 'present' : 'absent',
          clientIdRef.current
        ).catch(() => {});
      }
    }
  }, [selectedVehicleId, key, repName, broadcastLiveAction]);

  const handleToggleSponsored = useCallback((passengerId: string) => {
    lastLocalEditTimeRef.current = Date.now();
    recentlyEditedRidersRef.current.set(passengerId, Date.now());
    let nextVal = false;
    setSponsoredIds((prev) => {
      const next = new Set(prev);
      if (next.has(passengerId)) {
        next.delete(passengerId);
        nextVal = false;
      } else {
        next.add(passengerId);
        nextVal = true;
      }
      return next;
    });

    if (selectedVehicleId) {
      broadcastLiveAction({
        type: 'rider_sponsored',
        vehicleId: selectedVehicleId,
        riderId: passengerId,
        sponsored: nextVal,
        repName: repName.trim() || 'Co-rep',
        clientId: clientIdRef.current,
        timestamp: Date.now(),
      });
      if (key) {
        toggleRiderSponsoredInFirestore(
          key,
          selectedVehicleId,
          passengerId,
          nextVal,
          clientIdRef.current
        ).catch(() => {});
      }
    }
  }, [selectedVehicleId, key, repName, broadcastLiveAction]);

  const handleToggleUnpaid = useCallback((passengerId: string) => {
    lastLocalEditTimeRef.current = Date.now();
    recentlyEditedRidersRef.current.set(passengerId, Date.now());
    let nextVal = false;
    setUnpaidIds((prev) => {
      const next = new Set(prev);
      if (next.has(passengerId)) {
        next.delete(passengerId);
        nextVal = false;
      } else {
        next.add(passengerId);
        nextVal = true;
      }
      return next;
    });

    if (selectedVehicleId) {
      broadcastLiveAction({
        type: 'rider_unpaid',
        vehicleId: selectedVehicleId,
        riderId: passengerId,
        unpaid: nextVal,
        repName: repName.trim() || 'Co-rep',
        clientId: clientIdRef.current,
        timestamp: Date.now(),
      });
      if (key) {
        toggleRiderUnpaidInFirestore(
          key,
          selectedVehicleId,
          passengerId,
          nextVal,
          clientIdRef.current
        ).catch(() => {});
      }
    }
  }, [selectedVehicleId, key, repName, broadcastLiveAction]);

  const handleSetNote = useCallback((passengerId: string, text: string) => {
    lastLocalEditTimeRef.current = Date.now();
    recentlyEditedRidersRef.current.set(passengerId, Date.now());
    isUserDirtyRef.current = true;
    setNotes((prev) => ({ ...prev, [passengerId]: text }));

    if (selectedVehicleId) {
      broadcastLiveAction({
        type: 'rider_note',
        vehicleId: selectedVehicleId,
        riderId: passengerId,
        note: text,
        repName: repName.trim() || 'Co-rep',
        clientId: clientIdRef.current,
        timestamp: Date.now(),
      });
    }
  }, [selectedVehicleId, repName, broadcastLiveAction]);

  // Attendance Check: Mark all unticked riders as Absent
  const handleMarkUntickedAsAbsent = useCallback(() => {
    if (!riders.length) return;
    const now = Date.now();
    lastLocalEditTimeRef.current = now;
    isUserDirtyRef.current = true;

    const untickedRiderIds = riders
      .filter((r) => !presentIds.has(r.id) && !absentIds.has(r.id))
      .map((r) => r.id);

    if (untickedRiderIds.length === 0) return;

    untickedRiderIds.forEach((id) => recentlyEditedRidersRef.current.set(id, now));

    setAbsentIds((prev) => {
      const next = new Set(prev);
      untickedRiderIds.forEach((id) => next.add(id));
      return next;
    });

    setBatchActionMsg(`Marked ${untickedRiderIds.length} unticked passenger(s) as Absent.`);
    const t = setTimeout(() => setBatchActionMsg(null), 3500);
    return () => clearTimeout(t);
  }, [riders, presentIds, absentIds]);

  // Attendance Check: Mark all unticked riders as Present
  const handleMarkUntickedAsPresent = useCallback(() => {
    if (!riders.length) return;
    const now = Date.now();
    lastLocalEditTimeRef.current = now;
    isUserDirtyRef.current = true;

    const untickedRiderIds = riders
      .filter((r) => !presentIds.has(r.id) && !absentIds.has(r.id))
      .map((r) => r.id);

    if (untickedRiderIds.length === 0) return;

    untickedRiderIds.forEach((id) => recentlyEditedRidersRef.current.set(id, now));

    setPresentIds((prev) => {
      const next = new Set(prev);
      untickedRiderIds.forEach((id) => next.add(id));
      return next;
    });

    setBatchActionMsg(`Marked ${untickedRiderIds.length} unticked passenger(s) as Present.`);
    const t = setTimeout(() => setBatchActionMsg(null), 3500);
    return () => clearTimeout(t);
  }, [riders, presentIds, absentIds]);

  // Attendance Check: Reset all attendance marks
  const handleResetAllTicks = useCallback(() => {
    if (!riders.length) return;
    const now = Date.now();
    lastLocalEditTimeRef.current = now;
    isUserDirtyRef.current = true;
    const riderIdSet = new Set(riders.map((r) => r.id));
    riderIdSet.forEach((id) => recentlyEditedRidersRef.current.set(id, now));

    setPresentIds((prev) => {
      const next = new Set(prev);
      riderIdSet.forEach((id) => next.delete(id));
      return next;
    });
    setAbsentIds((prev) => {
      const next = new Set(prev);
      riderIdSet.forEach((id) => next.delete(id));
      return next;
    });

    setBatchActionMsg('Reset all attendance marks for this vehicle.');
    const t = setTimeout(() => setBatchActionMsg(null), 3000);
    return () => clearTimeout(t);
  }, [riders]);

  const addCoRep = () => {
    isUserDirtyRef.current = true;
    setCoReps((prev) => [...prev, '']);
  };
  const updateCoRep = (index: number, val: string) => {
    isUserDirtyRef.current = true;
    setCoReps((prev) => prev.map((c, i) => (i === index ? val : c)));
  };
  const removeCoRep = (index: number) => {
    isUserDirtyRef.current = true;
    setCoReps((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleCollectedCancellation = (entryId: string) => {
    isUserDirtyRef.current = true;
    setCollectedCancellationIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const addManualCancellation = (initialName?: string) => {
    isUserDirtyRef.current = true;
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
    isUserDirtyRef.current = true;
    setManualCancellations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeManualCancellation = (id: string) => {
    isUserDirtyRef.current = true;
    setManualCancellations((prev) => prev.filter((c) => c.id !== id));
  };

  const addExternalSponsee = () => {
    isUserDirtyRef.current = true;
    setExternalSponsees((prev) => [
      ...prev,
      { id: `sponsee-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sponseeName: '', taxiName: '', amount: FARE },
    ]);
  };

  const updateExternalSponsee = (id: string, patch: Partial<ExternalSponsee>) => {
    isUserDirtyRef.current = true;
    setExternalSponsees((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeExternalSponsee = (id: string) => {
    isUserDirtyRef.current = true;
    setExternalSponsees((prev) => prev.filter((s) => s.id !== id));
  };

  function findPassengerForTransfer(name: string, structure: string, passengers: Passenger[]): Passenger | undefined {
    if (!name.trim() || !passengers || passengers.length === 0) return undefined;
    const walkInInfo = { fullName: name.trim(), structure: structure.trim() || null };

    let bestMatch: Passenger | undefined = undefined;
    let bestScore = 0;

    for (const p of passengers) {
      const res = isPassengerTransferMatch(walkInInfo, { fullName: p.fullName, structure: p.structure });
      if (res.isMatch && res.score > bestScore) {
        bestMatch = p;
        bestScore = res.score;
      }
    }

    return bestMatch;
  }

  function findVehicleForPassenger(p: Passenger): Vehicle | undefined {
    if (!manifest) return undefined;
    if (p.assignedTo) {
      const v = manifest.vehicles.find((veh) => veh.id === p.assignedTo);
      if (v) return v;
    }
    return manifest.vehicles.find((veh) => veh.riders.includes(p.id));
  }

  function orderedStopsWith(vehicle: Vehicle, poolKey: string): string[] {
    const existing = vehicle.orderedStops ?? [];
    return existing.includes(poolKey) ? existing : [...existing, poolKey];
  }

  async function handleAddWalkIn(overrideCrossTransfer = false) {
    if (!manifest || !selectedVehicle || !walkInName.trim()) return;
    const query = walkInName.trim();
    const effectiveStruct = walkInStructure.trim();

    // 1. First check within current manifest (same service, different vehicle)
    const existing = findPassengerForTransfer(query, effectiveStruct, manifest.signups);

    if (existing && !overrideCrossTransfer) {
      const fromVehicle = findVehicleForPassenger(existing);
      if (fromVehicle && fromVehicle.id !== selectedVehicle.id) {
        setTransferPrompt({
          passenger: existing,
          fromVehicle,
          fromService: service,
          fromServiceLabel: serviceLabel,
          isCrossService: false,
          isCompatible: true,
          statusDescription: `Allocated to ${fromVehicle.name} (${serviceLabel})`,
        });
        return;
      }
      await assignWalkIn(existing, fromVehicle?.id ?? existing.assignedTo ?? null);
      setWalkInName('');
      setWalkInStructure('');
      setWalkInOpen(false);
      return;
    }

    // 2. If not found in current service and not overriding, cross-check other services for this date
    // Note: AM <-> PM is strictly excluded in crossCheckPassengerAcrossDate so no modal/popup appears for cross-period.
    if (!overrideCrossTransfer) {
      setIsCheckingCrossService(true);
      try {
        const crossMatches = await crossCheckPassengerAcrossDate(date, service, query, effectiveStruct);
        if (crossMatches.length > 0) {
          const match = crossMatches[0];
          setTransferPrompt({
            passenger: match.passenger,
            fromVehicle: match.vehicle,
            fromService: match.service,
            fromServiceLabel: match.serviceLabel,
            isCrossService: true,
            isCompatible: true,
            statusDescription: match.statusLabel,
          });
          setIsCheckingCrossService(false);
          return;
        }
      } catch (err) {
        console.error('Cross-check error:', err);
      } finally {
        setIsCheckingCrossService(false);
      }
    }

    // 3. Not found in any compatible service or confirmed as new walk-in: create fresh walk-in
    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
    lastLocalEditTimeRef.current = Date.now();

    const extracted = extractStructureFromText(query);
    const finalName = extracted.cleanText || query;
    const finalStructure = (effectiveStruct || extracted.structure || '').toUpperCase();

    const newPassenger: Passenger = {
      id: `walkin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fullName: finalName,
      stop: 'Walk-In',
      structure: finalStructure,
      assignedTo: selectedVehicle.id,
      present: true,
      cancellationFeeOwed: false,
    };
    const draftMetadata: Partial<VehicleDraftState> = {
      repName: repName.trim() || selectedVehicle.repName || '',
      licensePlate: licensePlate.trim() || selectedVehicle.licensePlate || '',
      generalNotes: generalNotes.trim() || selectedVehicle.generalNotes || '',
      updatedBy: clientIdRef.current,
    };

    setPresentIds((prev) => new Set(prev).add(newPassenger.id));
    setAbsentIds((prev) => {
      if (!prev.has(newPassenger.id)) return prev;
      const next = new Set(prev);
      next.delete(newPassenger.id);
      return next;
    });

    // Atomic transaction in Firestore: allows multiple users to append walk-ins simultaneously
    // without race conditions or manual syncing
    await appendWalkIn(selectedVehicle.id, newPassenger, draftMetadata);
    setWalkInName('');
    setWalkInStructure('');
    setWalkInOpen(false);
  }

  async function assignWalkIn(passenger: Passenger, fromVehicleId: string | null) {
    if (!manifest || !selectedVehicle) return;

    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
    lastLocalEditTimeRef.current = Date.now();

    const poolKey = hubDisplayName(selectedVehicle.type, passenger.stop || 'Walk-In');

    const updatedSignups = manifest.signups.map((p) =>
      p.id === passenger.id ? { ...p, assignedTo: selectedVehicle.id, present: true } : p
    );
    if (!updatedSignups.some((p) => p.id === passenger.id)) {
      updatedSignups.push({ ...passenger, assignedTo: selectedVehicle.id, present: true });
    }

    const updatedVehicles = manifest.vehicles.map((v) => {
      if (fromVehicleId && v.id === fromVehicleId && v.id !== selectedVehicle.id) {
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
        const nextRiders = v.riders.includes(passenger.id) ? v.riders : [...v.riders, passenger.id];
        const nextOrderedStops = orderedStopsWith(v, poolKey);
        const existingDraftPresent = v.draftState?.presentIds ?? [];
        const nextDraftPresent = existingDraftPresent.includes(passenger.id)
          ? existingDraftPresent
          : [...existingDraftPresent, passenger.id];
        const nextDraftAbsent = (v.draftState?.absentIds ?? []).filter((id) => id !== passenger.id);

        const nextDraft: VehicleDraftState = {
          presentIds: nextDraftPresent,
          absentIds: nextDraftAbsent,
          sponsoredIds: v.draftState?.sponsoredIds ?? Array.from(sponsoredIds),
          notes: v.draftState?.notes ?? notes,
          repName: repName.trim() || v.repName || '',
          coReps: coReps.filter(Boolean),
          licensePlate: licensePlate.trim() || v.licensePlate || '',
          generalNotes: generalNotes.trim() || v.generalNotes || '',
          cashCollected: { base: baseCash, external: externalCash, pastCancellations: pastCancellationCash },
          settledLedgerIds: Array.from(collectedCancellationIds),
          manualCancellations,
          externalSponsees,
          updatedAt: new Date().toISOString(),
          updatedBy: clientIdRef.current,
        };

        return {
          ...v,
          riders: nextRiders,
          orderedStops: nextOrderedStops,
          draftState: nextDraft,
        };
      }

      if (v.riders.includes(passenger.id) && v.id !== selectedVehicle.id) {
        const nextRiders = v.riders.filter((id) => id !== passenger.id);
        const cleanedDraft = v.draftState ? {
          ...v.draftState,
          presentIds: v.draftState.presentIds?.filter((id) => id !== passenger.id),
          absentIds: v.draftState.absentIds?.filter((id) => id !== passenger.id),
          sponsoredIds: v.draftState.sponsoredIds?.filter((id) => id !== passenger.id),
        } : undefined;
        return { ...v, riders: nextRiders, draftState: cleanedDraft };
      }

      return v;
    });

    const nextManifest: Manifest = {
      ...manifest,
      signups: updatedSignups,
      vehicles: updatedVehicles,
    };

    manifestRef.current = nextManifest;

    setPresentIds((prev) => new Set(prev).add(passenger.id));
    setAbsentIds((prev) => {
      if (!prev.has(passenger.id)) return prev;
      const next = new Set(prev);
      next.delete(passenger.id);
      return next;
    });

    await save(nextManifest);
  }

  async function confirmTransfer() {
    if (!transferPrompt || transferring || !selectedVehicle) return;
    setTransferring(true);
    try {
      if (transferPrompt.isCrossService) {
        const res = await transferPassengerAcrossServices({
          date,
          fromService: transferPrompt.fromService,
          toService: service,
          passengerId: transferPrompt.passenger.id,
          toVehicleId: selectedVehicle.id,
          repName,
          licensePlate,
        });

        if (!res.success) {
          setBatchActionMsg(`⚠️ Transfer failed: ${res.error || 'Unable to transfer passenger.'}`);
          setTimeout(() => setBatchActionMsg(null), 6000);
          return;
        }

        setPresentIds((prev) => new Set(prev).add(transferPrompt.passenger.id));
        setAbsentIds((prev) => {
          if (!prev.has(transferPrompt.passenger.id)) return prev;
          const next = new Set(prev);
          next.delete(transferPrompt.passenger.id);
          return next;
        });

        setBatchActionMsg(`✓ Successfully transferred ${transferPrompt.passenger.fullName} into ${selectedVehicle.name}`);
        setTimeout(() => setBatchActionMsg(null), 5000);
      } else {
        await assignWalkIn(transferPrompt.passenger, transferPrompt.fromVehicle?.id ?? null);
        setBatchActionMsg(`✓ Assigned ${transferPrompt.passenger.fullName} into ${selectedVehicle.name}`);
        setTimeout(() => setBatchActionMsg(null), 4000);
      }

      setTransferPrompt(null);
      setWalkInName('');
      setWalkInStructure('');
      setWalkInOpen(false);
    } catch (e) {
      console.error('Walk-in transfer error:', e);
      setBatchActionMsg(`⚠️ Error performing transfer: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setBatchActionMsg(null), 6000);
    } finally {
      setTransferring(false);
    }
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

      const finalizedDraft: VehicleDraftState = {
        presentIds: Array.from(presentIds),
        absentIds: Array.from(absentIds),
        sponsoredIds: Array.from(sponsoredIds),
        unpaidIds: Array.from(unpaidIds),
        notes,
        repName: repName.trim(),
        coReps: coReps.map((c) => c.trim()).filter(Boolean),
        licensePlate: licensePlate.trim(),
        generalNotes: generalNotes.trim(),
        cashCollected: { base: baseCash, external: externalCash, pastCancellations: pastCancellationCash },
        settledLedgerIds: Array.from(collectedCancellationIds),
        manualCancellations,
        externalSponsees,
        updatedAt: new Date().toISOString(),
        updatedBy: clientIdRef.current,
      };

      const updatedSignups = manifest.signups.map((p) => {
        if (presentIds.has(p.id)) {
          return {
            ...p,
            present: true,
            sponsored: sponsoredIds.has(p.id),
            sponsorNote: notes[p.id] || p.sponsorNote || '',
            didNotPay: unpaidIds.has(p.id),
            unpaidNote: notes[p.id] || p.unpaidNote || '',
          };
        }
        if (absentIds.has(p.id)) {
          return {
            ...p,
            present: false,
            sponsored: false,
            didNotPay: false,
            sponsorNote: notes[p.id] || p.sponsorNote || '',
          };
        }
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
              draftState: finalizedDraft,
            }
          : v
      );

      await save({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });

      try {
        localStorage.setItem(`crc_rep_draft_${key}_${selectedVehicle.id}`, JSON.stringify(finalizedDraft));
      } catch {
        // storage unavailable
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
      const vehicleRiderNames = riders.map((r) => r.fullName);
      await withdrawAbsentees(key, vehicleRiderNames);

      const updatedVehicles = manifest.vehicles.map((v) =>
        v.id === selectedVehicle.id
          ? { ...v, submitted: false, submittedAt: undefined, submittedBy: undefined }
          : v
      );
      await save({ ...manifest, vehicles: updatedVehicles });

      setSubmitMsg(
        `Attendance reopened for editing. Unconfirmed absentees have been withdrawn from the cancellation ledger until you submit again.`
      );
    } catch (e) {
      setSubmitMsg(`Error reopening: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const handleSelectVehicle = (newVehicleId: string) => {
    // 1. Immediately persist outgoing vehicle's draft if dirty
    if (selectedVehicleId && isUserDirtyRef.current && selectedVehicle && !selectedVehicle.submitted) {
      const pIdsArray = Array.from(presentIds);
      const aIdsArray = Array.from(absentIds);
      const nowIso = new Date().toISOString();
      const currentDraft: VehicleDraftState = {
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
      try {
        localStorage.setItem(`crc_rep_draft_${key}_${selectedVehicleId}`, JSON.stringify(currentDraft));
      } catch {
        // storage unavailable
      }
      updateVehicleDraft(
        selectedVehicleId,
        currentDraft,
        repName.trim(),
        licensePlate.trim(),
        pIdsArray,
        aIdsArray
      ).catch(() => {});
    }

    if (pendingSyncTimerRef.current) {
      clearTimeout(pendingSyncTimerRef.current);
      pendingSyncTimerRef.current = null;
    }
    isUserDirtyRef.current = false;
    isApplyingDraftRef.current = true;
    setSelectedVehicleId(newVehicleId);
    setSubmitMsg(null);
    setRiderSearch('');
  };

  const isSubmitted = selectedVehicle?.submitted ?? false;

  // Filtered riders based on search text and status tab
  const filteredRiders = useMemo(() => {
    const q = riderSearch.trim().toLowerCase();
    return riders.filter((r) => {
      // Tab filter
      if (riderFilter === 'unticked') {
        if (presentIds.has(r.id) || absentIds.has(r.id)) return false;
      } else if (riderFilter === 'present') {
        if (!presentIds.has(r.id)) return false;
      } else if (riderFilter === 'absent') {
        if (!absentIds.has(r.id)) return false;
      }

      // Search query
      if (!q) return true;
      return (
        r.fullName.toLowerCase().includes(q) ||
        (r.stop || '').toLowerCase().includes(q) ||
        (r.structure || '').toLowerCase().includes(q)
      );
    });
  }, [riders, riderSearch, riderFilter, presentIds, absentIds]);

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
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className={`inline-block h-2 w-2 rounded-full ${isSyncing ? 'bg-amber-400 animate-ping' : 'bg-success'}`} />
              <span>{isSyncing ? 'Syncing…' : 'Live Synced'}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={isSyncing}
            title="Force instant sync from cloud"
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-line bg-card/80 hover:bg-card-2 text-ink-muted hover:text-ink transition active:scale-95 disabled:opacity-50"
          >
            <RotateCcw className={`h-3 w-3 text-crimson-400 ${isSyncing ? 'animate-spin' : ''}`} />
            <span className="text-[11px] font-semibold">Sync</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-5">
        <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-ink">
              Transport Rep Portal
            </h1>
            <p className="text-xs text-muted">
              Check in passengers and record vehicle attendance.
            </p>
          </div>
          <span className="badge bg-card-2 text-ink-muted border border-line text-[10px]">
            Rep
          </span>
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
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded-full bg-crimson-500" />
                  <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">
                    Select Your Vehicle
                  </h2>
                </div>
                {selectedVehicle && (
                  <span className="text-xs font-semibold text-crimson-400">
                    {selectedVehicle.name} ({selectedVehicle.type})
                  </span>
                )}
              </div>

              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                Choose Taxi or Bus
              </label>
              <div className="relative mb-3">
                <Car className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <select
                  value={selectedVehicleId}
                  onChange={(e) => handleSelectVehicle(e.target.value)}
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

              {!selectedVehicleId ? (
                <div className="space-y-2 border-t border-line/60 pt-3">
                  <p className="text-xs text-muted">
                    Or find your vehicle by typing your name:
                  </p>
                  <input
                    type="text"
                    value={repName}
                    onChange={(e) => {
                      setRepName(e.target.value);
                    }}
                    placeholder="Start typing your name to match your vehicle…"
                    className="input-field text-xs"
                  />
                </div>
              ) : (
                <div className="space-y-3 border-t border-line/60 pt-3">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                        Your Name (Rep / Driver) <span className="text-crimson-400">*</span>
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
                      onChange={(e) => {
                        isUserDirtyRef.current = true;
                        setRepName(e.target.value);
                      }}
                      placeholder="Enter rep name for this vehicle…"
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
                          onClick={() => {
                            isUserDirtyRef.current = true;
                            setRepName(detectedOfficialRep);
                          }}
                          className="text-xs font-bold text-crimson-400 underline hover:text-crimson-300"
                        >
                          Use Name
                        </button>
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
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase();
                        isUserDirtyRef.current = true;
                        setLicensePlate(val);
                        if (selectedVehicleId) {
                          broadcastLiveAction({
                            type: 'vehicle_license_plate',
                            vehicleId: selectedVehicleId,
                            licensePlate: val,
                            repName: repName.trim() || 'Co-rep',
                            clientId: clientIdRef.current,
                            timestamp: Date.now(),
                          });
                        }
                      }}
                      placeholder="Required for this vehicle — e.g. GP 123 ABC"
                      className="input-field uppercase"
                    />
                  </div>

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
                </div>
              )}
            </div>

            {selectedVehicle && draftRestored && (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-2.5 text-xs text-success-light animate-fade-in">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                <span>Working draft restored — your progress is preserved.</span>
              </div>
            )}

            {selectedVehicle && !isSubmitted && !draftRestored && (
              <div className="flex items-center justify-between rounded-lg border border-line bg-card/60 px-3 py-1.5 text-[11px] text-muted">
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${isSyncing ? 'bg-amber-400 animate-ping' : 'bg-success'}`} />
                  {isSyncing ? 'Syncing across devices…' : 'Live synced across all devices & reps'}
                </span>
                <button
                  type="button"
                  onClick={() => refresh()}
                  disabled={isSyncing}
                  className="flex items-center gap-1 text-[11px] font-semibold text-crimson-400 hover:text-crimson-300 transition"
                >
                  <RotateCcw className={`h-2.5 w-2.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  <span>Sync now</span>
                </button>
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

                {/* Quick Actions: Walk-in & Settle Cancellation */}
                {!isSubmitted && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {/* Walk-in card */}
                    <div className="card border-line bg-card p-2.5">
                      {!walkInOpen ? (
                        <button
                          type="button"
                          onClick={() => setWalkInOpen(true)}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-crimson-500/30 bg-crimson-500/5 py-1.5 px-2.5 text-xs font-semibold text-crimson-300 hover:bg-crimson-500/10 hover:border-crimson-500/50 transition-all"
                        >
                          <UserPlus className="h-3.5 w-3.5 text-crimson-400 shrink-0" />
                          <span>+ Add Walk-In</span>
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
                          <div className="flex flex-col gap-2">
                            <input
                              type="text"
                              value={walkInName}
                              onChange={(e) => setWalkInName(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleAddWalkIn()}
                              placeholder="Full name (e.g. Sipho Dlamini)"
                              className="input-field text-xs font-medium"
                              autoFocus
                            />
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={walkInStructure}
                                onChange={(e) => setWalkInStructure(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddWalkIn()}
                                placeholder="Structure (e.g. S3)"
                                className="input-field text-xs flex-1 uppercase"
                              />
                              <button
                                type="button"
                                onClick={() => handleAddWalkIn()}
                                disabled={!walkInName.trim() || isCheckingCrossService}
                                className="btn-crimson px-3 py-2 text-xs font-bold whitespace-nowrap shadow-sm disabled:opacity-40 flex items-center gap-1.5"
                              >
                                {isCheckingCrossService && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                <span>{isCheckingCrossService ? 'Checking…' : 'Add'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => { setWalkInOpen(false); setWalkInName(''); setWalkInStructure(''); }}
                                className="btn-ghost px-2.5 py-2 text-xs"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Find & Settle Cancellation Button */}
                    <div className="card border-line bg-card p-2.5 flex flex-col justify-center">
                      <button
                        type="button"
                        onClick={() => {
                          ensurePastCancellationsLoaded();
                          setShowCancellationModal(true);
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-card-2 py-1.5 px-2.5 text-xs font-medium text-ink hover:border-crimson-500/40 hover:bg-card-2/80 transition-all"
                      >
                        <Banknote className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                        <span className="truncate">Settle Past Debt</span>
                        {(collectedCancellationIds.size > 0 || manualCancellations.length > 0) && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
                            +{collectedCancellationIds.size + manualCancellations.length} (+R{pastCancellationCash})
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* PASSENGER SEARCH & ATTENDANCE CHECK TOOLBAR */}
                <div className="card space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <div className="h-4 w-1 rounded-full bg-crimson-500" />
                      <h3 className="font-display text-xs font-bold uppercase tracking-wider text-ink">
                        Passenger Attendance Check
                      </h3>
                    </div>
                    <div className="flex items-center gap-1 bg-card-2 rounded-lg p-0.5 border border-line">
                      <button
                        type="button"
                        onClick={() => setViewMode('stop')}
                        className={`px-2 py-1 text-[11px] font-semibold rounded ${
                          viewMode === 'stop' ? 'bg-crimson-600 text-white shadow-xs' : 'text-muted hover:text-ink'
                        }`}
                      >
                        By Stop
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode('alpha')}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded ${
                          viewMode === 'alpha' ? 'bg-crimson-600 text-white shadow-xs' : 'text-muted hover:text-ink'
                        }`}
                      >
                        <ArrowDownAZ className="h-3 w-3" />
                        A-Z
                      </button>
                    </div>
                  </div>

                  {/* Search Bar for Quick Person-by-Person Check */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                    <input
                      type="text"
                      value={riderSearch}
                      onChange={(e) => setRiderSearch(e.target.value)}
                      placeholder="Search passenger in this bus by name, stop, or structure…"
                      className="input-field pl-9 pr-8 text-xs font-medium"
                    />
                    {riderSearch && (
                      <button
                        type="button"
                        onClick={() => setRiderSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Filter Tabs: All / Unticked / Present / Absent */}
                  <div className="grid grid-cols-4 gap-1 rounded-lg bg-card-2 p-1 border border-line text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setRiderFilter('all')}
                      className={`rounded py-1.5 text-center transition-all ${
                        riderFilter === 'all' ? 'bg-card text-ink shadow-xs' : 'text-muted hover:text-ink'
                      }`}
                    >
                      All ({riders.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRiderFilter('unticked')}
                      className={`rounded py-1.5 text-center transition-all ${
                        riderFilter === 'unticked'
                          ? 'bg-crimson-500/20 text-crimson-300 font-bold border border-crimson-500/40 shadow-xs'
                          : untickedCount > 0
                          ? 'text-warning font-bold'
                          : 'text-muted hover:text-ink'
                      }`}
                    >
                      Unticked ({untickedCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRiderFilter('present')}
                      className={`rounded py-1.5 text-center transition-all ${
                        riderFilter === 'present' ? 'bg-success/20 text-success-light shadow-xs' : 'text-muted hover:text-ink'
                      }`}
                    >
                      Present ({presentCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setRiderFilter('absent')}
                      className={`rounded py-1.5 text-center transition-all ${
                        riderFilter === 'absent' ? 'bg-crimson-500/20 text-crimson-300 shadow-xs' : 'text-muted hover:text-ink'
                      }`}
                    >
                      Absent ({absentCount})
                    </button>
                  </div>

                  {/* Fast Action: Mark Unticked as Absent */}
                  {!isSubmitted && (
                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      {untickedCount > 0 ? (
                        <>
                          <button
                            type="button"
                            onClick={handleMarkUntickedAsAbsent}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-crimson-500/40 bg-crimson-500/10 px-3 py-2 text-xs font-bold text-crimson-300 hover:bg-crimson-500/20 transition-all shadow-xs"
                            title="Place all remaining passengers who were not ticked into the Absent section"
                          >
                            <XCircle className="h-4 w-4 text-crimson-400" />
                            Mark Unticked as Absent ({untickedCount})
                          </button>
                          <button
                            type="button"
                            onClick={handleMarkUntickedAsPresent}
                            className="flex items-center justify-center gap-1 rounded-lg border border-success/40 bg-success/10 px-2.5 py-2 text-xs font-semibold text-success-light hover:bg-success/20 transition-all shadow-xs"
                            title="Mark all remaining unticked passengers as Present"
                          >
                            <CheckCircle2 className="h-4 w-4 text-success" />
                            All Present
                          </button>
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs font-semibold text-success-light">
                          <Check className="h-4 w-4" />
                          All {riders.length} passengers checked in
                        </div>
                      )}

                      {touchedCount > 0 && (
                        <button
                          type="button"
                          onClick={handleResetAllTicks}
                          className="flex items-center justify-center gap-1 rounded-lg border border-line bg-card-2/50 px-2.5 py-2 text-[11px] font-medium text-muted hover:text-ink hover:bg-card-2"
                          title="Reset attendance check for this vehicle"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Reset
                        </button>
                      )}
                    </div>
                  )}

                  {batchActionMsg && (
                    <div className="rounded-md border border-crimson-500/30 bg-crimson-900/20 px-3 py-1.5 text-xs text-crimson-200 animate-fade-in flex items-center justify-between">
                      <span>{batchActionMsg}</span>
                      <button onClick={() => setBatchActionMsg(null)} className="text-muted hover:text-ink">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* PASSENGER CHECKLIST (GROUPED BY STOP OR ALPHABETICAL LIST) */}
                {viewMode === 'stop' && !riderSearch ? (
                  <StopGroupedChecklist
                    riders={filteredRiders}
                    vehicleType={selectedVehicle?.type ?? 'Taxi'}
                    orderedStops={selectedVehicle?.orderedStops}
                    stopRedirects={selectedVehicle?.stopRedirects}
                    presentIds={presentIds}
                    absentIds={absentIds}
                    onSetPresent={handleSetPresent}
                    onToggleSponsored={handleToggleSponsored}
                    onToggleUnpaid={handleToggleUnpaid}
                    onSetNote={handleSetNote}
                    sponsoredIds={sponsoredIds}
                    unpaidIds={unpaidIds}
                    notes={notes}
                    disabled={isSubmitted || submitting}
                    riderDebtsMap={riderDebtsMap}
                    collectedCancellationIds={collectedCancellationIds}
                    onToggleCancellation={toggleCollectedCancellation}
                  />
                ) : (
                  <AlphabeticalChecklist
                    riders={filteredRiders}
                    vehicleType={selectedVehicle?.type ?? 'Taxi'}
                    stopRedirects={selectedVehicle?.stopRedirects}
                    presentIds={presentIds}
                    absentIds={absentIds}
                    onSetPresent={handleSetPresent}
                    onToggleSponsored={handleToggleSponsored}
                    onToggleUnpaid={handleToggleUnpaid}
                    onSetNote={handleSetNote}
                    sponsoredIds={sponsoredIds}
                    unpaidIds={unpaidIds}
                    notes={notes}
                    disabled={isSubmitted || submitting}
                    riderDebtsMap={riderDebtsMap}
                    collectedCancellationIds={collectedCancellationIds}
                    onToggleCancellation={toggleCollectedCancellation}
                  />
                )}

                {!isSubmitted && (
                  <>
                    {/* General notes */}
                    <div className="card">
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                        General Notes (optional)
                      </label>
                      <textarea
                        value={generalNotes}
                        onChange={(e) => {
                          const val = e.target.value;
                          isUserDirtyRef.current = true;
                          setGeneralNotes(val);
                          if (selectedVehicleId) {
                            broadcastLiveAction({
                              type: 'vehicle_general_notes',
                              vehicleId: selectedVehicleId,
                              generalNotes: val,
                              repName: repName.trim() || 'Co-rep',
                              clientId: clientIdRef.current,
                              timestamp: Date.now(),
                            });
                          }
                        }}
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
                      onSearchChange={(v) => {
                        setCancellationSearch(v);
                        ensurePastCancellationsLoaded();
                      }}
                      onEnsureLoaded={ensurePastCancellationsLoaded}
                      onOpenModal={() => {
                        ensurePastCancellationsLoaded();
                        setShowCancellationModal(true);
                      }}
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
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          Submitting…
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">
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

                {/* Copy Stats for Stats Link Accordion (at bottom of vehicle portal) */}
                <RepStatsCopyCard
                  riders={riders}
                  presentIds={presentIds}
                  absentIds={absentIds}
                  sponsoredIds={sponsoredIds}
                  unpaidIds={unpaidIds}
                  notes={notes}
                  vehicleName={selectedVehicle.name}
                  repName={repName}
                  isSubmitted={isSubmitted}
                />
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
          onClick={() => { if (!transferring) setTransferPrompt(null); }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-line bg-card p-6 shadow-crimson animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                transferPrompt.isCompatible
                  ? 'bg-warning/15 border-warning/30 text-warning'
                  : 'bg-crimson-500/15 border-crimson-500/30 text-crimson-400'
              }`}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-display text-base font-bold text-ink">
                  {transferPrompt.isCompatible ? 'Transfer Passenger' : 'Cross-Service Time Mismatch'}
                </h3>
                <p className="mt-1 text-xs text-muted">
                  <span className="font-semibold text-ink">{transferPrompt.passenger.fullName}</span> is registered in{' '}
                  <span className="font-semibold text-crimson-400">{transferPrompt.fromServiceLabel}</span>
                  {transferPrompt.fromVehicle ? ` (${transferPrompt.fromVehicle.name})` : ''}.
                </p>

                {/* Status Box */}
                <div className="mt-3 rounded-xl border border-line bg-card-2 p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between text-muted">
                    <span>Origin:</span>
                    <span className="font-semibold text-ink">
                      {transferPrompt.fromServiceLabel} {transferPrompt.fromVehicle ? `— ${transferPrompt.fromVehicle.name}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-muted">
                    <span>Destination:</span>
                    <span className="font-semibold text-success-light">
                      {serviceLabel} — {selectedVehicle?.name}
                    </span>
                  </div>
                  {transferPrompt.passenger.stop && (
                    <div className="flex items-center justify-between text-muted">
                      <span>Pickup Stop:</span>
                      <span className="font-medium text-ink">{transferPrompt.passenger.stop}</span>
                    </div>
                  )}
                  {transferPrompt.passenger.structure && (
                    <div className="flex items-center justify-between text-muted">
                      <span>Structure:</span>
                      <span className="font-mono font-semibold text-ink">{transferPrompt.passenger.structure}</span>
                    </div>
                  )}
                </div>

                {/* Compatibility Warning if incompatible */}
                {!transferPrompt.isCompatible && (
                  <div className="mt-3 rounded-lg border border-crimson-500/30 bg-crimson-500/10 p-2.5 text-xs text-crimson-200">
                    <p className="font-semibold mb-1">Different Service Time Window:</p>
                    <p className="text-[11px] leading-relaxed text-crimson-300 whitespace-pre-line">
                      {transferPrompt.incompatibleReason ||
                        'Transfers can only occur between matching service times (AM Service with AM Service, PM Service with PM Service).'}
                    </p>
                  </div>
                )}

                {transferPrompt.isCompatible && transferPrompt.isCrossService && (
                  <p className="mt-2 text-[11px] text-muted leading-relaxed">
                    Confirming will remove them from <strong>{transferPrompt.fromServiceLabel}</strong> and add them directly to <strong>{selectedVehicle?.name}</strong> as Present.
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTransferPrompt(null)}
                disabled={transferring}
                className="btn-ghost flex-1 disabled:opacity-50 text-xs"
              >
                Cancel
              </button>

              {transferPrompt.isCompatible ? (
                <button
                  type="button"
                  onClick={confirmTransfer}
                  disabled={transferring}
                  className="btn-crimson flex-1 flex items-center justify-center gap-1.5 disabled:opacity-50 text-xs font-bold"
                >
                  {transferring ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Transferring…</span>
                    </>
                  ) : (
                    <span>Confirm Transfer</span>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTransferPrompt(null);
                    handleAddWalkIn(true);
                  }}
                  disabled={transferring}
                  className="btn-crimson flex-1 flex items-center justify-center gap-1.5 disabled:opacity-50 text-xs font-bold"
                >
                  Add as New Walk-In Anyway
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cancellation & Debt Search / Settlement Modal */}
      <CancellationSearchModal
        isOpen={showCancellationModal}
        onClose={() => setShowCancellationModal(false)}
        pastCancellations={pastCancellations}
        loading={loadingPastCancellations}
        collectedCancellationIds={collectedCancellationIds}
        onToggleCancellation={toggleCollectedCancellation}
        manualCancellations={manualCancellations}
        onAddManualCancellation={addManualCancellation}
        onRemoveManualCancellation={removeManualCancellation}
        vehicleRiders={riders}
        fare={FARE}
      />
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
  const accentClass =
    accent === 'success'
      ? 'border-line bg-card text-success-light'
      : accent === 'crimson'
      ? 'border-line bg-card text-crimson-300'
      : 'border-line bg-card text-ink';

  return (
    <div className={`rounded-xl border p-3 text-center ${accentClass}`}>
      <div className="flex items-center justify-center gap-1 text-[11px] font-medium text-muted mb-0.5">
        {icon}
        <span>{label}</span>
      </div>
      <div className="font-display text-xl font-bold">{value}</div>
    </div>
  );
}

function formatServicePeriodMode(service: string): string {
  if (!service) return '';
  const code = extractServiceCode(service);
  if (code && code !== 'UNSPECIFIED') return code;
  const parts = service.split('—').map((s) => s.trim());
  const period = (parts[0] ?? '').split(' ')[0] || '';
  const mode = (parts[1] ?? '').replace(/only/i, '').trim();
  return [period, mode].filter(Boolean).join(' ') || service;
}

function CashCalculatorCard({
  presentCount, presentSponsoredCount, fare, grossPresentCash, sponsoredDeduction,
  externalSponsees, onAddSponsee, onUpdateSponsee, onRemoveSponsee, externalCash,
  pastCancellations, loadingPastCancellations, collectedCancellationIds, onToggleCancellation,
  manualCancellations,
  pastCancellationCash, search, onSearchChange, onEnsureLoaded, onOpenModal,
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
  onAddManualCancellation?: (initialName?: string) => void;
  onUpdateManualCancellation?: (id: string, patch: Partial<ManualCancellation>) => void;
  onRemoveManualCancellation?: (id: string) => void;
  pastCancellationCash: number;
  search: string;
  onSearchChange: (v: string) => void;
  onEnsureLoaded: () => void;
  onOpenModal?: () => void;
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
        {onOpenModal && (
          <button
            type="button"
            onClick={onOpenModal}
            className="flex items-center gap-1 text-xs font-semibold text-crimson-400 hover:text-crimson-300"
          >
            <Search className="h-3.5 w-3.5" />
            Full Search Modal
          </button>
        )}
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
          {onOpenModal && (
            <button
              type="button"
              onClick={onOpenModal}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-card-2 px-2.5 py-1 text-xs font-semibold text-ink hover:bg-card hover:border-crimson-500/40 hover:text-crimson-300 transition-colors shadow-xs"
            >
              <Search className="h-3.5 w-3.5 text-crimson-400" />
              <span>Find & Settle Debtors</span>
            </button>
          )}
        </div>

        {/* Selected ledger items */}
        {selectedCancellations.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {selectedCancellations.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-950/20 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-emerald-200">
                  <span className="font-semibold">{e.passenger_name}</span>
                  <span className="text-muted"> — {shortDate(e.date)} · {formatServicePeriodMode(e.service)}</span>
                  {e.structure && <span className="text-muted"> ({e.structure})</span>}
                  <span className="ml-1.5 font-bold font-mono text-emerald-300">+R{e.structure_debt || fare}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onToggleCancellation(e.id)}
                  className="shrink-0 rounded p-1 text-muted hover:bg-crimson-900/30 hover:text-crimson-300"
                  title="Remove from settled cash"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Search bar */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onFocus={onEnsureLoaded}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Quick search debtor name to settle (e.g. Sipho, Mnisi)..."
            className="input-field py-1.5 pl-8 text-xs font-medium"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {search.trim().length > 0 && (
          <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-card-2/40 p-2 animate-fade-in">
            {loadingPastCancellations ? (
              <p className="py-2 text-center text-[11px] text-muted">Loading debt entries…</p>
            ) : searchResults.length > 0 ? (
              searchResults.map((e) => {
                const isSettled = selectedCancellations.some((sc) => sc.id === e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onToggleCancellation(e.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                      isSettled
                        ? 'border-emerald-500/50 bg-emerald-950/25 text-emerald-200'
                        : 'border-line bg-card hover:border-crimson-500/40 hover:bg-card-2/60 text-ink'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{e.passenger_name}</span>
                      <span className="mt-0.5 block text-[10px] text-muted">
                        {shortDate(e.date)} · {formatServicePeriodMode(e.service)}
                        {e.structure && ` · ${e.structure}`}
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-1 font-mono text-[11px] font-bold text-crimson-400">
                      {isSettled ? '✓ Settled' : `+ Settle R${e.structure_debt || fare}`}
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="py-2 text-center text-[11px] text-muted">
                No matching cancellation found for &ldquo;{search.trim()}&rdquo;. Use &ldquo;Find & Settle Debtors&rdquo; for full list.
              </p>
            )}
          </div>
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
  riders, vehicleType, orderedStops, stopRedirects, presentIds, absentIds, onSetPresent, onToggleSponsored, onToggleUnpaid, onSetNote, sponsoredIds, unpaidIds, notes, disabled,
  riderDebtsMap, collectedCancellationIds, onToggleCancellation,
}: {
  riders: Passenger[];
  vehicleType: 'Bus' | 'Taxi';
  orderedStops?: string[];
  stopRedirects?: Record<string, string>;
  presentIds: Set<string>;
  absentIds: Set<string>;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onToggleUnpaid: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  sponsoredIds: Set<string>;
  unpaidIds: Set<string>;
  notes: Record<string, string>;
  disabled: boolean;
  riderDebtsMap?: Record<string, LedgerEntry[]>;
  collectedCancellationIds?: Set<string>;
  onToggleCancellation?: (id: string) => void;
}) {
  const byStop = useMemo(() => {
    const groups: Record<string, Passenger[]> = {};
    for (const r of riders) {
      if (!r) continue;
      const label = getEffectiveStop({ type: vehicleType, stopRedirects }, r.stop);
      if (!groups[label]) groups[label] = [];
      groups[label].push(r);
    }
    return groups;
  }, [riders, vehicleType, stopRedirects]);

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

  if (riders.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-6 text-center text-xs text-muted">
        No passengers match this filter.
      </div>
    );
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
        const stopRiders = byStop[stop] || [];
        if (stopRiders.length === 0) return null;
        const stopPresent = stopRiders.filter((r) => presentIds.has(r.id)).length;
        const stopTouched = stopRiders.filter((r) => presentIds.has(r.id) || absentIds.has(r.id)).length;
        const isExpanded = expandedStops.has(stop);

        const redirectedRiders = stopRiders.filter((r) => hubDisplayName(vehicleType, r.stop) !== stop);
        const redirectedFrom = Array.from(new Set(redirectedRiders.map((r) => hubDisplayName(vehicleType, r.stop))));

        return (
          <div key={stop} className="overflow-hidden rounded-xl border border-line bg-card">
            <button
              onClick={() => toggleStop(stop)}
              className="flex w-full items-center justify-between gap-2 border-b border-line bg-card-2/50 p-3.5 text-left transition-colors hover:bg-card-2/80"
            >
              <div className="flex items-center gap-2 flex-wrap">
                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
                <MapPin className="h-4 w-4 text-crimson-400" />
                <span className="text-sm font-semibold text-ink">{stop}</span>
                {redirectedFrom.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                    incl. {redirectedRiders.length} from {redirectedFrom.join(', ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{stopPresent}/{stopRiders.length} present · {stopTouched}/{stopRiders.length} checked</span>
                <span className={`flex h-2 w-2 rounded-full ${stopTouched === stopRiders.length ? 'bg-success' : 'bg-crimson-500'}`} />
              </div>
            </button>

            {isExpanded && (
              <div className="divide-y divide-line/60 animate-fade-in">
                {stopRiders.map((p) => {
                  const origStop = hubDisplayName(vehicleType, p.stop);
                  const isRedirected = origStop !== stop;
                  return (
                    <PassengerRow
                      key={p.id}
                      passenger={p}
                      isPresent={presentIds.has(p.id)}
                      isAbsent={absentIds.has(p.id)}
                      touched={presentIds.has(p.id) || absentIds.has(p.id)}
                      onSetPresent={onSetPresent}
                      onToggleSponsored={onToggleSponsored}
                      onToggleUnpaid={onToggleUnpaid}
                      onSetNote={onSetNote}
                      isSponsored={sponsoredIds.has(p.id)}
                      isUnpaid={unpaidIds.has(p.id)}
                      noteText={notes[p.id] ?? ''}
                      redirectedFrom={isRedirected ? origStop : undefined}
                      disabled={disabled}
                      outstandingDebts={riderDebtsMap?.[p.id]}
                      collectedCancellationIds={collectedCancellationIds}
                      onToggleCancellation={onToggleCancellation}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AlphabeticalChecklist({
  riders, vehicleType, stopRedirects, presentIds, absentIds, onSetPresent, onToggleSponsored, onToggleUnpaid, onSetNote, sponsoredIds, unpaidIds, notes, disabled,
  riderDebtsMap, collectedCancellationIds, onToggleCancellation,
}: {
  riders: Passenger[];
  vehicleType?: 'Bus' | 'Taxi';
  stopRedirects?: Record<string, string>;
  presentIds: Set<string>;
  absentIds: Set<string>;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onToggleUnpaid: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  sponsoredIds: Set<string>;
  unpaidIds: Set<string>;
  notes: Record<string, string>;
  disabled: boolean;
  riderDebtsMap?: Record<string, LedgerEntry[]>;
  collectedCancellationIds?: Set<string>;
  onToggleCancellation?: (id: string) => void;
}) {
  const sorted = useMemo(() => {
    return [...riders].sort((a, b) => naturalCompare(a.fullName, b.fullName));
  }, [riders]);

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-card p-6 text-center text-xs text-muted">
        No passengers match this filter.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line/60">
      {sorted.map((p) => {
        const vType = vehicleType || 'Taxi';
        const origStop = hubDisplayName(vType, p.stop);
        const effStop = getEffectiveStop({ type: vType, stopRedirects }, p.stop);
        const isRedirected = origStop !== effStop;
        return (
          <PassengerRow
            key={p.id}
            passenger={p}
            isPresent={presentIds.has(p.id)}
            isAbsent={absentIds.has(p.id)}
            touched={presentIds.has(p.id) || absentIds.has(p.id)}
            onSetPresent={onSetPresent}
            onToggleSponsored={onToggleSponsored}
            onToggleUnpaid={onToggleUnpaid}
            onSetNote={onSetNote}
            isSponsored={sponsoredIds.has(p.id)}
            isUnpaid={unpaidIds.has(p.id)}
            noteText={notes[p.id] ?? ''}
            redirectedFrom={isRedirected ? origStop : undefined}
            disabled={disabled}
            outstandingDebts={riderDebtsMap?.[p.id]}
            collectedCancellationIds={collectedCancellationIds}
            onToggleCancellation={onToggleCancellation}
          />
        );
      })}
    </div>
  );
}

const PassengerRow = React.memo(function PassengerRow({
  passenger, isPresent, isAbsent, touched, onSetPresent, onToggleSponsored, onToggleUnpaid, onSetNote, isSponsored, isUnpaid, noteText, redirectedFrom, disabled,
  outstandingDebts, collectedCancellationIds, onToggleCancellation,
}: {
  passenger: Passenger;
  isPresent: boolean;
  isAbsent: boolean;
  touched: boolean;
  onSetPresent: (id: string, present: boolean) => void;
  onToggleSponsored: (id: string) => void;
  onToggleUnpaid: (id: string) => void;
  onSetNote: (id: string, text: string) => void;
  isSponsored: boolean;
  isUnpaid: boolean;
  noteText: string;
  redirectedFrom?: string;
  disabled: boolean;
  outstandingDebts?: LedgerEntry[];
  collectedCancellationIds?: Set<string>;
  onToggleCancellation?: (id: string) => void;
}) {
  const [showNote, setShowNote] = useState(isSponsored || isUnpaid || !!noteText);
  const [showDebtBreakdown, setShowDebtBreakdown] = useState(false);

  const totalDebtAmount = useMemo(() => {
    if (!outstandingDebts || outstandingDebts.length === 0) return 0;
    return outstandingDebts.reduce((sum, d) => sum + (Number(d.structure_debt) || FARE), 0);
  }, [outstandingDebts]);

  const settledDebtEntries = useMemo(() => {
    if (!outstandingDebts || !collectedCancellationIds) return [];
    return outstandingDebts.filter((d) => collectedCancellationIds.has(d.id));
  }, [outstandingDebts, collectedCancellationIds]);

  const settledDebtCount = settledDebtEntries.length;
  const settledDebtAmount = useMemo(() => {
    return settledDebtEntries.reduce((sum, d) => sum + (Number(d.structure_debt) || FARE), 0);
  }, [settledDebtEntries]);

  function handleSponsoredToggle() {
    onToggleSponsored(passenger.id);
    if (!isSponsored) setShowNote(true);
  }

  function handleUnpaidToggle() {
    onToggleUnpaid(passenger.id);
    if (!isUnpaid) setShowNote(true);
  }

  return (
    <div className={`p-3 transition-colors border-b border-line/40 last:border-b-0 ${disabled ? 'opacity-60' : 'hover:bg-card-2/20'} ${!touched && !disabled ? 'border-l-2 border-l-amber-500/60' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-semibold ${isPresent ? 'text-success-light' : isAbsent ? 'text-crimson-300' : 'text-ink'}`}>
              {passenger.fullName}
            </span>
            {passenger.structure && (
              <span className="rounded bg-card-2 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-muted border border-line">
                {passenger.structure}
              </span>
            )}
            {(() => {
              const statusBadge = getPassengerStatusBadge(passenger);
              return statusBadge ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusBadge.colorClass}`} title={statusBadge.title}>
                  {statusBadge.label}
                </span>
              ) : null;
            })()}
            {redirectedFrom ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                From {redirectedFrom}
              </span>
            ) : passenger.stop ? (
              <span className="text-[11px] text-muted truncate max-w-[140px]" title={passenger.stop}>
                · {passenger.stop}
              </span>
            ) : null}
            {!touched && !disabled && (
              <span className="text-[10px] text-amber-400/80 font-medium">
                (unmarked)
              </span>
            )}
          </div>
        </div>

        {/* Optimistic Instant Present / Absent Buttons */}
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => onSetPresent(passenger.id, true)}
            disabled={disabled}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all active:scale-95 ${
              isPresent
                ? 'bg-success/20 text-success-light border border-success/50'
                : 'bg-card-2 text-muted border border-line hover:border-line-bright hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Present
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSetPresent(passenger.id, false)}
            disabled={disabled}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all active:scale-95 ${
              isAbsent
                ? 'bg-crimson-500/20 text-crimson-300 border border-crimson-500/50'
                : 'bg-card-2 text-muted border border-line hover:border-line-bright hover:text-ink'
            }`}
          >
            <span className="flex items-center gap-1">
              <XCircle className="h-3.5 w-3.5" />
              Absent
            </span>
          </button>
        </div>
      </div>

      {/* Action Toggles: Sponsored, Didn't Pay, Settle Debt, and Note */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* Sponsored Toggle */}
        <button
          type="button"
          onClick={handleSponsoredToggle}
          disabled={disabled}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all active:scale-95 ${
            isSponsored
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
              : 'bg-card-2/60 text-muted border border-line hover:text-ink'
          }`}
          title="Mark if someone else is paying for this passenger"
        >
          <HeartHandshake className="h-3 w-3 text-amber-400" />
          {isSponsored ? 'Sponsored' : 'Sponsored'}
        </button>

        {/* Didn't Pay Toggle */}
        <button
          type="button"
          onClick={handleUnpaidToggle}
          disabled={disabled}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all active:scale-95 ${
            isUnpaid
              ? 'bg-crimson-500/20 text-crimson-300 border border-crimson-500/50 font-semibold'
              : 'bg-card-2/60 text-muted border border-line hover:text-ink'
          }`}
          title="Flag that this passenger attended but did not pay fare"
        >
          <AlertCircle className="h-3 w-3 text-crimson-400" />
          {isUnpaid ? "Didn't Pay" : "Didn't Pay"}
        </button>

        {/* Settle Debt Button (Reveals breakdown on tap) */}
        {outstandingDebts && outstandingDebts.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDebtBreakdown(!showDebtBreakdown)}
            disabled={disabled}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all active:scale-95 border ${
              settledDebtCount === outstandingDebts.length
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                : settledDebtCount > 0
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-card-2 text-crimson-300 border-line hover:border-crimson-500/30'
            }`}
            title="View and settle past unpaid cancellation trips"
          >
            <Banknote className={`h-3 w-3 ${settledDebtCount > 0 ? 'text-emerald-400' : 'text-crimson-400'}`} />
            <span>
              {settledDebtCount === outstandingDebts.length
                ? `Settled All (+R${totalDebtAmount})`
                : settledDebtCount > 0
                ? `Settling R${settledDebtAmount} of R${totalDebtAmount}`
                : `Settle Debt (R${totalDebtAmount})`}
            </span>
            <span className="text-[9px] opacity-75 ml-0.5">
              {showDebtBreakdown ? '▴' : '▾'}
            </span>
          </button>
        )}

        {/* Note button */}
        {(isSponsored || isUnpaid || showNote || noteText) && (
          <button
            type="button"
            onClick={() => setShowNote(!showNote)}
            disabled={disabled}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium border border-line bg-card-2/60 transition-all ${
              showNote ? 'text-ink border-line-bright' : 'text-muted hover:text-ink'
            }`}
          >
            <StickyNote className="h-3 w-3" />
            {showNote ? 'Hide Note' : 'Note'}
          </button>
        )}
      </div>

      {/* Settle Debt Breakdown Dropdown Panel */}
      {showDebtBreakdown && outstandingDebts && outstandingDebts.length > 0 && (
        <div className="mt-2.5 rounded-xl border border-line bg-card-2/85 p-3 text-xs animate-fade-in space-y-2">
          <div className="flex items-center justify-between border-b border-line/60 pb-2">
            <div className="flex items-center gap-1.5">
              <Banknote className="h-4 w-4 text-crimson-400" />
              <span className="font-bold text-ink text-xs">Past Unpaid Trips for {passenger.fullName}</span>
              <span className="text-[11px] text-muted">
                ({outstandingDebts.length} total • R{totalDebtAmount} debt)
              </span>
            </div>
            {outstandingDebts.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  const allSettled = settledDebtCount === outstandingDebts.length;
                  outstandingDebts.forEach((d) => {
                    const isSettled = collectedCancellationIds?.has(d.id);
                    if (allSettled && isSettled) {
                      onToggleCancellation?.(d.id);
                    } else if (!allSettled && !isSettled) {
                      onToggleCancellation?.(d.id);
                    }
                  });
                }}
                className="text-[11px] font-bold text-crimson-400 hover:text-crimson-300 underline"
              >
                {settledDebtCount === outstandingDebts.length ? 'Clear All' : `Settle All (R${totalDebtAmount})`}
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            {outstandingDebts.map((d) => {
              const isSettled = collectedCancellationIds?.has(d.id);
              const debtAmount = Number(d.structure_debt) || FARE;
              return (
                <div
                  key={d.id}
                  onClick={() => onToggleCancellation?.(d.id)}
                  className={`flex items-center justify-between gap-2.5 rounded-lg p-2 transition-all cursor-pointer border select-none ${
                    isSettled
                      ? 'border-emerald-500/50 bg-emerald-950/25'
                      : 'border-line/70 bg-card hover:border-crimson-500/40 hover:bg-card-2'
                  }`}
                >
                  <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-mono font-bold text-ink flex items-center gap-1">
                      <Calendar className="h-3 w-3 text-crimson-400" />
                      {d.date ? shortDate(d.date) : 'Undated'}
                    </span>
                    <span className="rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted border border-line/60">
                      {d.service || 'PM'}
                    </span>
                    {d.vehicle_name && (
                      <span className="text-muted text-[11px] flex items-center gap-1">
                        <Car className="h-3 w-3 text-muted/80" />
                        {d.vehicle_name}
                      </span>
                    )}
                    {d.stop && (
                      <span className="text-muted text-[11px] flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-muted/80" />
                        {d.stop}
                      </span>
                    )}
                    {d.general_notes && (
                      <span className="text-muted italic text-[10px] truncate max-w-xs">
                        ({d.general_notes})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-xs font-bold text-crimson-400">
                      R{debtAmount}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCancellation?.(d.id);
                      }}
                      disabled={disabled}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-all shadow-xs flex items-center gap-1 ${
                        isSettled
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : 'bg-crimson-600 text-white hover:bg-crimson-500'
                      }`}
                    >
                      {isSettled ? (
                        <>
                          <Check className="h-3 w-3" />
                          <span>Settled</span>
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" />
                          <span>Pay R{debtAmount}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Note input */}
      {showNote && (
        <div className="mt-2 animate-fade-in">
          <input
            type="text"
            value={noteText}
            onChange={(e) => onSetNote(passenger.id, e.target.value)}
            disabled={disabled}
            placeholder={
              isSponsored
                ? 'Required: Who is paying for this person? (e.g. Person A in Taxi 1)'
                : isUnpaid
                ? 'Note on unpaid fare (e.g. forgot cash, will pay next Sunday)'
                : 'Note for this passenger...'
            }
            className="input-field text-xs"
          />
          <p className="mt-1 text-[10px] text-muted">
            {isSponsored
              ? 'This note is included in the stats and cancellation ledger so we know who covers the cost.'
              : isUnpaid
              ? "Flagged for admin visibility under unpaid attendance records."
              : 'Note visible to reps and admin.'}
          </p>
        </div>
      )}
    </div>
  );
});

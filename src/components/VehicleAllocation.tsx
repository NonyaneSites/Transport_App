import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Bus, Car, Plus, Trash2, Users, ArrowRight, Undo2, X, UserCog, MoveRight,
  CheckCircle2, ChevronDown, ChevronRight, ChevronUp, MapPin,
  Check, Clock, StickyNote, Sparkles, ArrowUpDown, UserCheck, Download,
  FileText, Copy, Eye, FileDown, Search, FileSpreadsheet
} from 'lucide-react';
import type { Manifest, Passenger, Vehicle, ServiceType } from '@/lib/types';
import { hubDisplayName } from '@/lib/types';
import { sortVehiclesNatural, naturalCompare } from '@/lib/sort';
import { passengersByStop, passengersByPoolGroup, unassignedPassengers } from '@/lib/manifest';
import { parseManifestKey } from '@/lib/dates';
import { allocateSubStopsIntact } from '@/lib/allocation';
import { detectVehicleRep, detectAllVehicleReps, getRepStructure, isPassengerRepOfVehicle, matchRiderToOfficialRep } from '@/lib/officialReps';
import {
  generateWhatsAppRouteManifest,
  generateWhatsAppRepManifest,
  downloadTextFile
} from '@/lib/whatsappManifest';
import {
  downloadTaxiStatsExcel,
  generateTaxiStatsTSV
} from '@/lib/statsExport';
import { AdminStatsExportModal } from '@/components/AdminStatsExportModal';

function DebouncedInput({
  value,
  onChange,
  placeholder,
  className,
  title,
  type = 'text',
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  type?: string;
}) {
  const [localVal, setLocalVal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalVal(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setLocalVal(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange(next);
    }, 450);
  };

  const handleBlur = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (localVal !== value) {
      onChange(localVal);
    }
  };

  return (
    <input
      type={type}
      value={localVal}
      onChange={handleChange}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={className}
      title={title}
    />
  );
}

interface Props {
  manifest: Manifest;
  serviceLabel?: string;
  service: ServiceType;
  onSave: (m: Manifest) => Promise<void>;
}

export function VehicleAllocation({ manifest, serviceLabel, service, onSave }: Props) {
  // Local optimistic state for instant zero-lag UI updates and rapid actions
  const [localManifest, setLocalManifest] = useState<Manifest>(manifest);
  const latestManifestRef = useRef<Manifest>(manifest);
  const isLocalMutationPendingRef = useRef<boolean>(false);
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync when parent manifest updates from cloud without overwriting active local edits
  useEffect(() => {
    if (!manifest) return;
    if (manifest.date !== latestManifestRef.current?.date) {
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
      }
      isLocalMutationPendingRef.current = false;
      latestManifestRef.current = manifest;
      setLocalManifest(manifest);
      return;
    }

    if (!isLocalMutationPendingRef.current && !saveDebounceTimerRef.current) {
      latestManifestRef.current = manifest;
      setLocalManifest(manifest);
    }
  }, [manifest]);

  // Flush any pending save on unmount
  useEffect(() => {
    return () => {
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
        onSave(latestManifestRef.current).catch(() => {});
      }
    };
  }, [onSave]);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'Bus' | 'Taxi'>('Bus');
  const [selectedPoolKey, setSelectedPoolKey] = useState('');
  const [assignQty, setAssignQty] = useState('');
  const [expandedVehicle, setExpandedVehicle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Search functionality for admins to find and move passengers
  const [adminSearchQuery, setAdminSearchQuery] = useState('');
  const [adminSearchFilter, setAdminSearchFilter] = useState<'all' | 'unassigned' | 'assigned' | 'reps' | 'ushers'>('all');
  const [searchMoveTarget, setSearchMoveTarget] = useState<Record<string, string>>({});
  const [moveNotification, setMoveNotification] = useState<{ text: string; timestamp: number } | null>(null);

  const [moveFromVehicle, setMoveFromVehicle] = useState<string>('');
  const [movePassengerId, setMovePassengerId] = useState<string>('');
  const [moveToVehicle, setMoveToVehicle] = useState<string>('');
  const [showSubmitted, setShowSubmitted] = useState(false);
  const [highlightRep, setHighlightRep] = useState<string | null>(null);
  const [copiedRoute, setCopiedRoute] = useState(false);
  const [copiedRep, setCopiedRep] = useState(false);
  const [copiedStatsTSV, setCopiedStatsTSV] = useState(false);
  const [previewManifestType, setPreviewManifestType] = useState<'route' | 'rep' | null>(null);
  const [statsModalOpen, setStatsModalOpen] = useState(false);

  const handleCopyStatsTSV = async () => {
    const tsv = generateTaxiStatsTSV(localManifest);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopiedStatsTSV(true);
      setTimeout(() => setCopiedStatsTSV(false), 2500);
    } catch {
      // Fallback
    }
  };

  /**
   * Performs an immediate synchronous mutation on the local manifest,
   * updating state with zero lag, while debouncing the cloud save to prevent
   * server flooding and race condition echoes during rapid actions.
   */
  const mutateAndSave = useCallback((updater: (prev: Manifest) => Manifest) => {
    const nextManifest = updater(latestManifestRef.current);
    latestManifestRef.current = nextManifest;
    setLocalManifest(nextManifest);
    isLocalMutationPendingRef.current = true;

    if (saveDebounceTimerRef.current) {
      clearTimeout(saveDebounceTimerRef.current);
    }

    setSaving(true);
    saveDebounceTimerRef.current = setTimeout(async () => {
      saveDebounceTimerRef.current = null;
      try {
        await onSave(latestManifestRef.current);
      } catch (err) {
        console.error('Cloud manifest save error:', err);
      } finally {
        setSaving(false);
        setTimeout(() => {
          isLocalMutationPendingRef.current = false;
        }, 1000);
      }
    }, 150);
  }, [onSave]);

  const unassigned = unassignedPassengers(localManifest);

  // Overview pool — always shown at the raw sub-stop level in numerical order of remaining signups
  const stopsMap = passengersByStop(unassigned);
  const stopNames = Object.keys(stopsMap)
    .filter((s) => stopsMap[s].length > 0)
    .sort((a, b) => stopsMap[b].length - stopsMap[a].length || naturalCompare(a, b));

  // Vehicle cards always render in natural alphanumeric order
  const sortedVehicles = sortVehiclesNatural(localManifest?.vehicles || []);
  const submittedVehicles = sortVehiclesNatural((localManifest?.vehicles || []).filter((v) => v?.submitted));

  function poolForVehicleType(vehicleType: 'Bus' | 'Taxi'): { key: string; count: number }[] {
    const map = passengersByPoolGroup(unassigned, vehicleType);
    const keys = Object.keys(map)
      .filter((k) => map[k] && map[k].length > 0)
      .sort((a, b) => map[b].length - map[a].length || naturalCompare(a, b));
    return keys.map((k) => ({ key: k, count: map[k].length }));
  }

  function riderPassengers(vehicle?: Vehicle | null): Passenger[] {
    if (!vehicle || !Array.isArray(vehicle.riders)) return [];
    const signups = localManifest?.signups || [];
    return vehicle.riders
      .map((id) => signups.find((p) => p && p.id === id))
      .filter((p): p is Passenger => Boolean(p));
  }

  function ridersGroupedByHub(vehicle: Vehicle): { label: string; riders: Passenger[] }[] {
    const riders = riderPassengers(vehicle);
    const groups: Record<string, Passenger[]> = {};
    for (const r of riders) {
      if (!r) continue;
      const label = hubDisplayName(vehicle?.type || 'Taxi', r.stop);
      if (!groups[label]) groups[label] = [];
      groups[label].push(r);
    }
    const order = vehicle?.orderedStops ?? [];
    const orderedLabels = order.filter((l) => groups[l]);
    const extraLabels = Object.keys(groups)
      .filter((l) => !orderedLabels.includes(l))
      .sort((a, b) => (groups[b]?.length || 0) - (groups[a]?.length || 0));
    return [...orderedLabels, ...extraLabels].map((label) => ({ label, riders: groups[label] || [] }));
  }

  function addVehicle() {
    if (!newName.trim()) return;
    const vehicle: Vehicle = {
      id: `veh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: newName.trim(),
      type: newType,
      riders: [],
      orderedStops: [],
    };
    mutateAndSave((prev) => ({
      ...prev,
      vehicles: sortVehiclesNatural([...prev.vehicles, vehicle]),
    }));
    setNewName('');
  }

  function removeVehicle(vehicleId: string) {
    mutateAndSave((prev) => {
      const vehicle = prev.vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) return prev;
      const updatedSignups = prev.signups.map((p) =>
        vehicle.riders.includes(p.id) ? { ...p, assignedTo: null } : p
      );
      const updatedVehicles = prev.vehicles.filter((v) => v.id !== vehicleId);
      return { ...prev, signups: updatedSignups, vehicles: updatedVehicles };
    });
  }

  /**
   * Assigns passengers to a vehicle by pool group key using Atomic Sub-Stop Group Allocation.
   * Automatically detects and allocates official structure transport reps on board (matching nicknames, structure & surnames).
   */
  function assignToVehicle(vehicleId: string, poolKey: string, qty: number | 'all') {
    if (!poolKey) return;
    mutateAndSave((prev) => {
      const vehicle = prev.vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) return prev;

      const unassignedList = unassignedPassengers(prev);
      const pool = unassignedList.filter((p) => hubDisplayName(vehicle.type, p.stop) === poolKey);
      let toAssign: Passenger[];
      if (qty === 'all') {
        toAssign = pool;
      } else {
        const { allocated } = allocateSubStopsIntact(pool, qty);
        toAssign = allocated;
      }
      if (toAssign.length === 0) return prev;

      const updatedSignups = prev.signups.map((p) => {
        const match = toAssign.find((t) => t.id === p.id);
        if (match) return { ...p, assignedTo: vehicleId };
        return p;
      });

      const updatedVehicles = prev.vehicles.map((v) => {
        if (v.id !== vehicleId) return v;
        const orderedStops = v.orderedStops ?? [];
        const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];

        const nextRiders = [...v.riders, ...toAssign.map((p) => p.id)];
        const riderObjs = updatedSignups.filter((p) => nextRiders.includes(p.id));
        
        // Auto-detect official structure rep (e.g. S9 Amo Nhlabathi -> Amogelang Nhlabathi)
        const autoRep = detectVehicleRep(riderObjs);

        return {
          ...v,
          riders: nextRiders,
          orderedStops: nextOrderedStops,
          // If no rep is set, or if vehicle is a taxi and a rep is on board, auto-allocate them!
          repName: v.repName || autoRep || undefined,
        };
      });

      return { ...prev, signups: updatedSignups, vehicles: updatedVehicles };
    });

    setSelectedPoolKey('');
    setAssignQty('');
  }

  function moveStopOrder(vehicleId: string, stopLabel: string, direction: 'up' | 'down') {
    mutateAndSave((prev) => {
      const vehicle = prev.vehicles.find((v) => v.id === vehicleId);
      if (!vehicle) return prev;

      const groups = ridersGroupedByHub(vehicle);
      const currentLabels = groups.map((g) => g.label);
      const index = currentLabels.indexOf(stopLabel);
      if (index === -1) return prev;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= currentLabels.length) return prev;

      const newOrder = [...currentLabels];
      const [moved] = newOrder.splice(index, 1);
      newOrder.splice(targetIndex, 0, moved);

      const updatedVehicles = prev.vehicles.map((v) =>
        v.id === vehicleId ? { ...v, orderedStops: newOrder } : v
      );
      return { ...prev, vehicles: updatedVehicles };
    });
  }

  /**
   * Fast, glitch-free removal of an individual rider from a vehicle.
   * Completely immune to rapid multi-click race conditions.
   */
  function unassignRider(vehicleId: string, passengerId: string) {
    mutateAndSave((prev) => {
      const updatedSignups = prev.signups.map((p) =>
        p.id === passengerId ? { ...p, assignedTo: null } : p
      );
      const updatedVehicles = prev.vehicles.map((v) => {
        if (v.id !== vehicleId) return v;
        const nextRiders = v.riders.filter((id) => id !== passengerId);
        const remainingRiderObjs = updatedSignups.filter((p) => nextRiders.includes(p.id));
        const activeHubs = new Set(remainingRiderObjs.map((p) => hubDisplayName(v.type, p.stop)));
        const nextOrderedStops = (v.orderedStops ?? []).filter((s) => activeHubs.has(s));

        // Re-check official rep: if removed passenger was the rep, detect if another rep is on board
        const detectedRep = detectVehicleRep(remainingRiderObjs);
        const repStillOnBoard = v.repName && remainingRiderObjs.some((r) => isPassengerRepOfVehicle(r, v.repName));

        return {
          ...v,
          riders: nextRiders,
          orderedStops: nextOrderedStops,
          repName: repStillOnBoard ? v.repName : (detectedRep || undefined),
        };
      });

      return { ...prev, signups: updatedSignups, vehicles: updatedVehicles };
    });
  }

  function unassignAllFromVehicle(vehicleId: string) {
    mutateAndSave((prev) => {
      const vehicle = prev.vehicles.find((v) => v.id === vehicleId);
      if (!vehicle || vehicle.riders.length === 0) return prev;
      const updatedSignups = prev.signups.map((p) =>
        vehicle.riders.includes(p.id) ? { ...p, assignedTo: null } : p
      );
      const updatedVehicles = prev.vehicles.map((v) =>
        v.id === vehicleId ? { ...v, riders: [], orderedStops: [], repName: undefined } : v
      );
      return { ...prev, signups: updatedSignups, vehicles: updatedVehicles };
    });
  }

  function setRepName(vehicleId: string, repName: string) {
    mutateAndSave((prev) => {
      const updatedVehicles = prev.vehicles.map((v) =>
        v.id === vehicleId ? { ...v, repName: repName.trim() || undefined } : v
      );
      return { ...prev, vehicles: updatedVehicles };
    });
  }

  function setStopTime(vehicleId: string, label: string, time: string) {
    mutateAndSave((prev) => {
      const updatedVehicles = prev.vehicles.map((v) =>
        v.id === vehicleId ? { ...v, stopTimes: { ...(v.stopTimes ?? {}), [label]: time } } : v
      );
      return { ...prev, vehicles: updatedVehicles };
    });
  }

  function setVehicleNote(vehicleId: string, note: string) {
    mutateAndSave((prev) => {
      const updatedVehicles = prev.vehicles.map((v) =>
        v.id === vehicleId ? { ...v, generalNotes: note } : v
      );
      return { ...prev, vehicles: updatedVehicles };
    });
  }

  function movePassenger(
    passengerId: string,
    fromVehicleId: string | 'unassigned' | '',
    toVehicleId: string | 'unassigned' | ''
  ) {
    if (!passengerId || !toVehicleId || fromVehicleId === toVehicleId) return;

    mutateAndSave((prev) => {
      const passenger = prev.signups.find((p) => p.id === passengerId);
      if (!passenger) return prev;

      const isUnassigning = toVehicleId === 'unassigned';
      const toVehicle = !isUnassigning ? prev.vehicles.find((v) => v.id === toVehicleId) : null;
      if (!isUnassigning && !toVehicle) return prev;

      const poolKey = toVehicle ? hubDisplayName(toVehicle.type, passenger.stop) : '';

      // 1. Update signups
      const updatedSignups = prev.signups.map((p) =>
        p.id === passengerId ? { ...p, assignedTo: isUnassigning ? null : toVehicleId } : p
      );

      // 2. Update vehicles
      const updatedVehicles = prev.vehicles.map((v) => {
        // Origin vehicle (if it was assigned to a vehicle)
        if (fromVehicleId && fromVehicleId !== 'unassigned' && v.id === fromVehicleId) {
          const nextRiders = v.riders.filter((id) => id !== passengerId);
          const remainingRiders = updatedSignups.filter((p) => nextRiders.includes(p.id));
          const detected = detectVehicleRep(remainingRiders);
          const repStillOnBoard = v.repName && remainingRiders.some((r) => isPassengerRepOfVehicle(r, v.repName));

          // Clean up draftState so draft echoes never hold this passenger
          const cleanedDraft = v.draftState
            ? {
                ...v.draftState,
                presentIds: v.draftState.presentIds?.filter((id) => id !== passengerId),
                absentIds: v.draftState.absentIds?.filter((id) => id !== passengerId),
                sponsoredIds: v.draftState.sponsoredIds?.filter((id) => id !== passengerId),
              }
            : undefined;

          const activeHubs = new Set(remainingRiders.map((p) => hubDisplayName(v.type, p.stop)));
          const nextOrderedStops = (v.orderedStops ?? []).filter((s) => activeHubs.has(s));

          return {
            ...v,
            riders: nextRiders,
            orderedStops: nextOrderedStops,
            draftState: cleanedDraft,
            repName: repStillOnBoard ? v.repName : (detected || undefined),
          };
        }

        // Destination vehicle
        if (!isUnassigning && v.id === toVehicleId) {
          const orderedStops = v.orderedStops ?? [];
          const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];
          const nextRiders = v.riders.includes(passengerId) ? v.riders : [...v.riders, passengerId];
          const allRiders = updatedSignups.filter((p) => nextRiders.includes(p.id));
          const autoRep = detectVehicleRep(allRiders);

          return {
            ...v,
            riders: nextRiders,
            orderedStops: nextOrderedStops,
            repName: v.repName || autoRep || undefined,
          };
        }

        return v;
      });

      return { ...prev, signups: updatedSignups, vehicles: updatedVehicles };
    });

    const targetPassenger = localManifest.signups.find((p) => p.id === passengerId);
    const destName =
      toVehicleId === 'unassigned'
        ? 'Unassigned Pool'
        : localManifest.vehicles.find((v) => v.id === toVehicleId)?.name || 'Vehicle';

    if (targetPassenger) {
      setMoveNotification({
        text: `✓ Moved ${targetPassenger.fullName} to ${destName}`,
        timestamp: Date.now(),
      });
      setTimeout(() => setMoveNotification(null), 3500);
    }

    setMoveFromVehicle('');
    setMovePassengerId('');
    setMoveToVehicle('');
  }

  // Filtered passenger search results for Admin
  const filteredSearchPassengers = useMemo(() => {
    const q = adminSearchQuery.trim().toLowerCase();
    const signups = localManifest?.signups || [];
    const vehicles = localManifest?.vehicles || [];
    return signups.filter((p) => {
      if (!p) return false;
      // 1. Role / status filter tab
      if (adminSearchFilter === 'unassigned' && p.assignedTo) return false;
      if (adminSearchFilter === 'assigned' && !p.assignedTo) return false;
      if (adminSearchFilter === 'reps') {
        const isOfficial = matchRiderToOfficialRep(p);
        const assignedVeh = p.assignedTo ? vehicles.find((v) => v?.id === p.assignedTo) : null;
        const isActiveRep = assignedVeh ? isPassengerRepOfVehicle(p, assignedVeh.repName) : false;
        if (!isOfficial && !isActiveRep) return false;
      }
      if (adminSearchFilter === 'ushers' && p.category !== 'Ushers') return false;

      // 2. Query matching
      if (!q) return true;

      const nameMatch = (p.fullName || '').toLowerCase().includes(q);
      const stopMatch = (p.stop || '').toLowerCase().includes(q);
      const structMatch = (p.structure || '').toLowerCase().includes(q);
      const phoneMatch = (p.phone || '').includes(q);
      const ministryMatch = (p.ministry || '').toLowerCase().includes(q);
      const assignedVeh = p.assignedTo ? vehicles.find((v) => v?.id === p.assignedTo) : null;
      const vehMatch = assignedVeh ? (assignedVeh.name || '').toLowerCase().includes(q) : false;

      return nameMatch || stopMatch || structMatch || phoneMatch || ministryMatch || vehMatch;
    });
  }, [localManifest?.signups, localManifest?.vehicles, adminSearchQuery, adminSearchFilter]);

  async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    }
  }

  async function handleCopyRouteManifest() {
    const text = generateWhatsAppRouteManifest(localManifest, service);
    await copyTextToClipboard(text);
    setCopiedRoute(true);
    setTimeout(() => setCopiedRoute(false), 2000);
  }

  function handleDownloadRouteManifest() {
    const text = generateWhatsAppRouteManifest(localManifest, service);
    const { date: sessionDate } = parseManifestKey(localManifest.date);
    downloadTextFile(`whatsapp_manifest_${sessionDate}_${service}.txt`, text);
  }

  async function handleCopyRepManifest() {
    const text = generateWhatsAppRepManifest(localManifest, service);
    await copyTextToClipboard(text);
    setCopiedRep(true);
    setTimeout(() => setCopiedRep(false), 2000);
  }

  function handleDownloadRepManifest() {
    const text = generateWhatsAppRepManifest(localManifest, service);
    const { date: sessionDate } = parseManifestKey(localManifest.date);
    downloadTextFile(`whatsapp_rep_manifest_${sessionDate}_${service}.txt`, text);
  }

  const hasAllocatedVehicles = localManifest.vehicles.length > 0 && localManifest.vehicles.some((v) => riderPassengers(v).length > 0);

  return (
    <div className="card">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-1 rounded-full bg-crimson-500" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Vehicle Route Allocation</h2>
          {saving && <span className="text-[11px] text-muted animate-pulse font-mono">Syncing…</span>}
        </div>

        {/* Quick manifest export action buttons in header */}
        {hasAllocatedVehicles && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Route Manifest Button Group */}
            <div className="inline-flex rounded-lg border border-success/30 bg-success/10 p-0.5 shadow-sm">
              <button
                type="button"
                onClick={handleDownloadRouteManifest}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-success-light hover:bg-success/20 transition-colors"
                title="Download WhatsApp Route Manifest (.txt)"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Route Manifest (.txt)</span>
              </button>
              <div className="w-[1px] bg-success/20 my-1" />
              <button
                type="button"
                onClick={handleCopyRouteManifest}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-success-light hover:bg-success/20 transition-colors"
                title="Copy Route Manifest to clipboard"
              >
                {copiedRoute ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedRoute ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                onClick={() => setPreviewManifestType('route')}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-medium text-success-light/80 hover:bg-success/20 transition-colors"
                title="Preview Route Manifest"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Rep Manifest Button Group */}
            <div className="inline-flex rounded-lg border border-amber-500/30 bg-amber-500/10 p-0.5 shadow-sm">
              <button
                type="button"
                onClick={handleDownloadRepManifest}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors"
                title="Download WhatsApp Rep Manifest with passenger roster (.txt)"
              >
                <FileDown className="h-3.5 w-3.5" />
                <span>Rep Manifest (.txt)</span>
              </button>
              <div className="w-[1px] bg-amber-500/20 my-1" />
              <button
                type="button"
                onClick={handleCopyRepManifest}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors"
                title="Copy Rep Manifest with passenger roster to clipboard"
              >
                {copiedRep ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedRep ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                onClick={() => setPreviewManifestType('rep')}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-medium text-amber-300/80 hover:bg-amber-500/20 transition-colors"
                title="Preview Rep Manifest"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Taxi Stats for Excel & Google Sheets Button Group */}
            <div className="inline-flex rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => downloadTaxiStatsExcel(localManifest)}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Download full Taxi Stats workbook (.xlsx) for Excel"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                <span>Taxi Stats (.xlsx)</span>
              </button>
              <div className="w-[1px] bg-emerald-500/25 my-1" />
              <button
                type="button"
                onClick={handleCopyStatsTSV}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Copy tab-delimited table to paste directly into Google Sheets columns"
              >
                {copiedStatsTSV ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedStatsTSV ? 'Copied Sheets!' : 'Copy Sheets'}</span>
              </button>
              <button
                type="button"
                onClick={() => setStatsModalOpen(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 transition-colors bg-emerald-500/15"
                title="Open Taxi Stats Export & Table Preview Console"
              >
                <Eye className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export Hub</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manifest Preview Modal */}
      {previewManifestType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-line bg-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/60">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-crimson-400" />
                <div>
                  <h3 className="font-display text-sm font-bold text-ink">
                    {previewManifestType === 'route' ? 'WhatsApp Route Manifest Preview' : 'WhatsApp Rep Manifest Preview'}
                  </h3>
                  <p className="text-[11px] text-muted">
                    {previewManifestType === 'route'
                      ? 'Formatted for transport coordination and driver stop times'
                      : 'Formatted with numbered passenger roster by stop for vehicle reps'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewManifestType(null)}
                className="rounded-lg p-1.5 text-muted hover:bg-card hover:text-ink transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewManifestType('route')}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                      previewManifestType === 'route'
                        ? 'bg-success/20 text-success-light border border-success/40'
                        : 'bg-card-2 text-muted hover:text-ink'
                    }`}
                  >
                    Route Manifest
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewManifestType('rep')}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                      previewManifestType === 'rep'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-card-2 text-muted hover:text-ink'
                    }`}
                  >
                    Rep Manifest (With Riders)
                  </button>
                </div>
              </div>

              <pre className="rounded-xl border border-line bg-black/60 p-4 font-mono text-xs text-ink/90 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto select-all">
                {previewManifestType === 'route'
                  ? generateWhatsAppRouteManifest(localManifest, service)
                  : generateWhatsAppRepManifest(localManifest, service)}
              </pre>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5 bg-card-2/60">
              {previewManifestType === 'route' ? (
                <>
                  <button
                    type="button"
                    onClick={handleCopyRouteManifest}
                    className="btn-ghost text-xs px-3 py-2 flex items-center gap-1.5 border-line"
                  >
                    {copiedRoute ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    <span>{copiedRoute ? 'Copied to Clipboard' : 'Copy to Clipboard'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadRouteManifest}
                    className="btn-success text-xs px-4 py-2 flex items-center gap-1.5"
                  >
                    <Download className="h-4 w-4" />
                    <span>Download .txt</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleCopyRepManifest}
                    className="btn-ghost text-xs px-3 py-2 flex items-center gap-1.5 border-line"
                  >
                    {copiedRep ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    <span>{copiedRep ? 'Copied to Clipboard' : 'Copy to Clipboard'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadRepManifest}
                    className="btn-crimson text-xs px-4 py-2 flex items-center gap-1.5"
                  >
                    <Download className="h-4 w-4" />
                    <span>Download .txt</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Taxi Stats for Excel & Google Sheets Modal */}
      <AdminStatsExportModal
        manifest={localManifest}
        serviceLabel={serviceLabel}
        isOpen={statsModalOpen}
        onClose={() => setStatsModalOpen(false)}
      />

      {/* Add vehicle */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Vehicle Name</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addVehicle()}
            placeholder="e.g. Bus 1, Taxi 7"
            className="input-field"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Type</label>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as 'Bus' | 'Taxi')}
            className="input-field"
          >
            <option value="Bus" className="bg-card-2">Bus</option>
            <option value="Taxi" className="bg-card-2">Taxi</option>
          </select>
        </div>
        <button onClick={addVehicle} disabled={!newName.trim()} className="btn-crimson">
          <Plus className="h-4 w-4" />
          Add Vehicle
        </button>
      </div>

      {/* Unassigned pool overview — raw sub-stop level, regardless of vehicle type */}
      {unassigned.length > 0 && (
        <div className="mb-5 rounded-xl border border-line bg-card-2/50 p-4">
          <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Unassigned Pool</span>
              <span className="badge bg-crimson-500/15 text-crimson-300">{unassigned.length} waiting</span>
            </div>
            {/* Breakdown by Category */}
            <div className="flex items-center gap-1.5 text-[11px]">
              {unassigned.filter((p) => p.category === 'Ushers').length > 0 && (
                <span className="badge bg-amber-500/15 text-amber-300">
                  {unassigned.filter((p) => p.category === 'Ushers').length} Ushers (Early)
                </span>
              )}
              {unassigned.filter((p) => p.category === 'Normal').length > 0 && (
                <span className="badge bg-sky-500/15 text-sky-300">
                  {unassigned.filter((p) => p.category === 'Normal').length} Normal
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stopNames.map((stop) => (
              <span key={stop} className="inline-flex items-center gap-1 rounded-md bg-bg/60 px-2 py-1 text-xs text-muted">
                {stop} <span className="font-semibold text-crimson-300">({stopsMap[stop].length} remaining)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Move notification toast */}
      {moveNotification && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-success/40 bg-success/15 px-4 py-2.5 text-xs font-semibold text-success-light animate-fade-in shadow-md">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <span>{moveNotification.text}</span>
          </div>
          <button
            onClick={() => setMoveNotification(null)}
            className="rounded p-1 text-success-light/70 hover:bg-success/20 hover:text-success-light"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Admin Passenger Search & Quick-Move Console */}
      <div className="mb-5 rounded-xl border border-line bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-crimson-400" />
            <span className="text-xs font-bold uppercase tracking-wide text-ink">
              Find & Move Passengers
            </span>
            <span className="badge bg-card-2 text-muted text-[11px]">
              {localManifest.signups.length} total signups
            </span>
          </div>
          {adminSearchQuery && (
            <button
              onClick={() => setAdminSearchQuery('')}
              className="text-[11px] text-muted hover:text-ink font-medium"
            >
              Clear search
            </button>
          )}
        </div>

        {/* Search input bar */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted pointer-events-none" />
          <input
            type="text"
            value={adminSearchQuery}
            onChange={(e) => setAdminSearchQuery(e.target.value)}
            placeholder="Search by name, structure (e.g. S3), pickup stop, phone, or assigned vehicle..."
            className="input-field pl-9 text-xs"
          />
          {adminSearchQuery && (
            <button
              onClick={() => setAdminSearchQuery('')}
              className="absolute right-2.5 top-2 rounded p-0.5 text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Filter category tabs */}
        <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
          <button
            type="button"
            onClick={() => setAdminSearchFilter('all')}
            className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
              adminSearchFilter === 'all'
                ? 'bg-crimson-600 text-white font-semibold shadow-xs'
                : 'bg-card-2 text-muted hover:bg-card-2/80 hover:text-ink'
            }`}
          >
            All ({localManifest.signups.length})
          </button>
          <button
            type="button"
            onClick={() => setAdminSearchFilter('unassigned')}
            className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
              adminSearchFilter === 'unassigned'
                ? 'bg-crimson-600 text-white font-semibold shadow-xs'
                : 'bg-card-2 text-muted hover:bg-card-2/80 hover:text-ink'
            }`}
          >
            Unassigned ({unassigned.length})
          </button>
          <button
            type="button"
            onClick={() => setAdminSearchFilter('assigned')}
            className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
              adminSearchFilter === 'assigned'
                ? 'bg-crimson-600 text-white font-semibold shadow-xs'
                : 'bg-card-2 text-muted hover:bg-card-2/80 hover:text-ink'
            }`}
          >
            Assigned ({localManifest.signups.length - unassigned.length})
          </button>
          <button
            type="button"
            onClick={() => setAdminSearchFilter('reps')}
            className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
              adminSearchFilter === 'reps'
                ? 'bg-amber-600 text-white font-semibold shadow-xs'
                : 'bg-card-2 text-muted hover:bg-card-2/80 hover:text-ink'
            }`}
          >
            ⭐ Official Reps
          </button>
          <button
            type="button"
            onClick={() => setAdminSearchFilter('ushers')}
            className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
              adminSearchFilter === 'ushers'
                ? 'bg-amber-600 text-white font-semibold shadow-xs'
                : 'bg-card-2 text-muted hover:bg-card-2/80 hover:text-ink'
            }`}
          >
            Ushers
          </button>
        </div>

        {/* Live Search Results List */}
        {(adminSearchQuery.trim() !== '' || adminSearchFilter !== 'all') && (
          <div className="mt-3 rounded-lg border border-line/60 bg-bg/40 p-3 max-h-96 overflow-y-auto space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted mb-1">
              <span>
                Found <strong className="text-ink">{filteredSearchPassengers.length}</strong> matching person{filteredSearchPassengers.length === 1 ? '' : 's'}
              </span>
              {filteredSearchPassengers.length > 30 && (
                <span>Showing first 30 results (type to narrow down)</span>
              )}
            </div>

            {filteredSearchPassengers.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted">
                No passengers found matching "{adminSearchQuery}".
              </div>
            ) : (
              filteredSearchPassengers.slice(0, 35).map((p) => {
                const assignedVehicle = p.assignedTo ? localManifest.vehicles.find((v) => v.id === p.assignedTo) : null;
                const isOfficialRep = matchRiderToOfficialRep(p);
                const isActiveRep = assignedVehicle ? isPassengerRepOfVehicle(p, assignedVehicle.repName) : false;
                const targetVeh = searchMoveTarget[p.id] !== undefined ? searchMoveTarget[p.id] : '';

                return (
                  <div
                    key={p.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border border-line/70 bg-card p-2.5 hover:border-line transition-all shadow-xs"
                  >
                    {/* Passenger details */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-xs text-ink">{p.fullName}</span>
                        {p.structure && (
                          <span className="badge bg-crimson-500/10 text-crimson-300 font-mono text-[10px]">
                            {p.structure}
                          </span>
                        )}
                        {isOfficialRep && (
                          <span className="badge bg-amber-500/15 text-amber-300 font-semibold text-[10px] flex items-center gap-0.5">
                            ⭐ Official Rep ({isOfficialRep.structure})
                          </span>
                        )}
                        {isActiveRep && !isOfficialRep && (
                          <span className="badge bg-amber-500/15 text-amber-300 font-semibold text-[10px]">
                            ★ Active Rep
                          </span>
                        )}
                        {p.category === 'Ushers' && (
                          <span className="badge bg-amber-500/10 text-amber-300 text-[10px]">
                            Usher
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted flex-wrap">
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-muted" />
                          {p.stop}
                        </span>
                        <span>·</span>
                        <span>
                          Current:{' '}
                          {assignedVehicle ? (
                            <strong className="text-sky-400">
                              {assignedVehicle.type === 'Bus' ? '🚌' : '🚕'} {assignedVehicle.name}
                            </strong>
                          ) : (
                            <span className="text-crimson-300 font-medium">⏳ Unassigned Pool</span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Quick Move Action */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <select
                        value={targetVeh}
                        onChange={(e) => setSearchMoveTarget((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        className="input-field py-1 text-xs w-40 bg-card-2"
                      >
                        <option value="" className="bg-card-2">
                          Move to...
                        </option>
                        {p.assignedTo && (
                          <option value="unassigned" className="bg-card-2 text-crimson-300">
                            ⏳ Unassigned Pool
                          </option>
                        )}
                        {sortVehiclesNatural(
                          localManifest.vehicles.filter((v) => v.id !== p.assignedTo)
                        ).map((v) => (
                          <option key={v.id} value={v.id} className="bg-card-2">
                            {v.type === 'Bus' ? '🚌' : '🚕'} {v.name} ({v.riders.length} riders)
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          if (!targetVeh) return;
                          movePassenger(p.id, p.assignedTo || 'unassigned', targetVeh);
                          setSearchMoveTarget((prev) => ({ ...prev, [p.id]: '' }));
                        }}
                        disabled={!targetVeh}
                        className="btn-crimson px-2.5 py-1 text-xs font-semibold whitespace-nowrap disabled:opacity-40"
                      >
                        Move
                      </button>
                      {assignedVehicle && (
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedVehicle(assignedVehicle.id);
                            const el = document.getElementById(`vehicle-card-${assignedVehicle.id}`);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }}
                          className="btn-ghost p-1 text-muted hover:text-ink text-[11px]"
                          title="Locate Vehicle"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Move person between vehicles */}
      {localManifest.vehicles.length >= 2 && (
        <div id="move-passenger-section" className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 transition-all">
          <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <MoveRight className="h-4 w-4 text-amber-400" />
              <span className="text-xs font-bold uppercase tracking-wide text-ink">Move a person between vehicles</span>
            </div>
            <span className="text-[11px] text-muted">
              ★ Official reps are highlighted to help ensure every taxi has a rep
            </span>
          </div>

          {(() => {
            const fromVeh = localManifest.vehicles.find((v) => v.id === moveFromVehicle);
            const toVeh = localManifest.vehicles.find((v) => v.id === moveToVehicle);
            const fromRiders = fromVeh ? riderPassengers(fromVeh) : [];
            const repRiders = fromRiders.filter((p) => isPassengerRepOfVehicle(p, fromVeh?.repName) || matchRiderToOfficialRep(p));
            const generalRiders = fromRiders.filter((p) => !isPassengerRepOfVehicle(p, fromVeh?.repName) && !matchRiderToOfficialRep(p));
            const selectedPassenger = fromRiders.find((p) => p.id === movePassengerId);
            const selectedPassengerOfficial = selectedPassenger ? matchRiderToOfficialRep(selectedPassenger) : null;
            const selectedPassengerIsActiveRep = selectedPassenger && fromVeh ? isPassengerRepOfVehicle(selectedPassenger, fromVeh.repName) : false;

            const getVehicleRepLabel = (v: Vehicle) => {
              const r = riderPassengers(v);
              const detected = detectVehicleRep(r);
              const effective = v.repName || detected;
              if (effective) {
                const s = getRepStructure(effective);
                return `· Rep: ${effective}${s ? ` (${s})` : ''}`;
              }
              return '· ⚠️ No Rep';
            };

            return (
              <>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">From Vehicle</label>
                    <select
                      value={moveFromVehicle}
                      onChange={(e) => {
                        setMoveFromVehicle(e.target.value);
                        setMovePassengerId('');
                      }}
                      className="input-field py-2 text-xs"
                    >
                      <option value="" className="bg-card-2">Select origin vehicle...</option>
                      {sortVehiclesNatural(localManifest.vehicles.filter((v) => v.riders.length > 0)).map((v) => (
                        <option key={v.id} value={v.id} className="bg-card-2">
                          {v.name} ({v.riders.length} riders {getVehicleRepLabel(v)})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted flex items-center justify-between">
                      <span>Person</span>
                      {repRiders.length > 0 && (
                        <span className="text-amber-400 text-[10px] font-semibold">{repRiders.length} Rep{repRiders.length !== 1 ? 's' : ''} on board</span>
                      )}
                    </label>
                    <select
                      value={movePassengerId}
                      onChange={(e) => setMovePassengerId(e.target.value)}
                      className="input-field py-2 text-xs"
                      disabled={!moveFromVehicle}
                    >
                      <option value="" className="bg-card-2">Select person to transfer...</option>
                      {repRiders.length > 0 && (
                        <optgroup label="⭐ Official Structure Reps on board" className="bg-card-2 text-amber-300 font-bold">
                          {repRiders.map((p) => {
                            const isAct = isPassengerRepOfVehicle(p, fromVeh?.repName);
                            const repMatch = matchRiderToOfficialRep(p);
                            const prefix = isAct ? '★ [ACTIVE REP]' : '☆ [OFFICIAL REP]';
                            const struct = repMatch?.structure || p.structure || '—';
                            return (
                              <option key={p.id} value={p.id} className="bg-card-2 text-amber-200 font-semibold">
                                {prefix} {p.fullName} ({struct}) · {p.stop}
                              </option>
                            );
                          })}
                        </optgroup>
                      )}
                      {generalRiders.length > 0 && (
                        <optgroup label="👥 Passengers" className="bg-card-2 text-muted">
                          {generalRiders.map((p) => (
                            <option key={p.id} value={p.id} className="bg-card-2 text-ink">
                              {p.fullName} ({p.structure || '—'}) · {p.stop}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">To Vehicle</label>
                    <div className="flex gap-1.5">
                      <select
                        value={moveToVehicle}
                        onChange={(e) => setMoveToVehicle(e.target.value)}
                        className="input-field py-2 text-xs"
                        disabled={!movePassengerId}
                      >
                        <option value="" className="bg-card-2">Select destination...</option>
                        {sortVehiclesNatural(localManifest.vehicles.filter((v) => v.id !== moveFromVehicle)).map((v) => (
                          <option key={v.id} value={v.id} className="bg-card-2">
                            {v.name} ({v.riders.length} riders {getVehicleRepLabel(v)})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => movePassenger(movePassengerId, moveFromVehicle, moveToVehicle)}
                        disabled={!movePassengerId || !moveToVehicle}
                        className="btn-crimson px-3.5 py-2 text-xs whitespace-nowrap"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        Move
                      </button>
                    </div>
                  </div>
                </div>

                {/* Rep movement preview / assistance note */}
                {selectedPassenger && (
                  <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs">
                    {selectedPassengerOfficial || selectedPassengerIsActiveRep ? (
                      <div className="flex items-center gap-2 text-amber-200 flex-wrap">
                        <Sparkles className="h-4 w-4 text-amber-400 shrink-0" />
                        <span>
                          <strong>{selectedPassenger.fullName}</strong> is an <strong>Official Rep ({selectedPassengerOfficial?.structure || selectedPassenger.structure})</strong>.
                        </span>
                        {toVeh && !toVeh.repName && !detectVehicleRep(riderPassengers(toVeh)) && (
                          <span className="rounded bg-success/20 px-1.5 py-0.5 text-success-light font-bold text-[11px]">
                            ✓ Will provide rep coverage to {toVeh.name}!
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted">
                        Moving passenger <strong>{selectedPassenger.fullName}</strong> from <strong>{fromVeh?.name}</strong> to <strong>{toVeh?.name || 'destination'}</strong>.
                      </span>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Vehicle cards */}
      {localManifest.vehicles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Bus className="h-8 w-8 text-line" />
          <p className="text-sm text-muted">No vehicles created yet. Add a vehicle above to start assigning passengers.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedVehicles.map((vehicle) => {
            const riders = riderPassengers(vehicle);
            const isExpanded = expandedVehicle === vehicle.id;
            const Icon = vehicle.type === 'Bus' ? Bus : Car;
            const pool = poolForVehicleType(vehicle.type);
            const allDetectedReps = detectAllVehicleReps(riders);
            const detectedOfficialRep = allDetectedReps.length > 0 ? allDetectedReps[0].rep.fullName : null;
            const selectedRepObj = allDetectedReps.find((d) => isPassengerRepOfVehicle(d.rider, vehicle.repName));
            const repStruct = vehicle.repName
              ? getRepStructure(vehicle.repName)
              : (selectedRepObj ? selectedRepObj.rep.structure : (detectedOfficialRep ? getRepStructure(detectedOfficialRep) : null));
            const groups = ridersGroupedByHub(vehicle);

            return (
              <div
                key={vehicle.id}
                className={`overflow-hidden rounded-xl border transition-all hover:border-crimson-500/30 ${
                  vehicle.submitted ? 'border-success/30 bg-success/5' : 'border-line bg-card-2'
                }`}
              >
                <div className="flex items-center justify-between gap-3 p-4">
                  <button
                    onClick={() => { setExpandedVehicle(isExpanded ? null : vehicle.id); setSelectedPoolKey(''); setAssignQty(''); }}
                    className="flex flex-1 items-center gap-3 text-left"
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                      vehicle.type === 'Bus' ? 'bg-crimson-500/15 text-crimson-400' : 'bg-success/15 text-success-light'
                    }`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-ink">{vehicle.name}</span>
                        {vehicle.submitted && (
                          <span className="badge bg-success/15 text-success-light text-[10px]">Submitted</span>
                        )}
                        {allDetectedReps.length > 1 ? (
                          <span className="badge bg-amber-500/15 text-amber-300 text-[10px] flex items-center gap-1 border border-amber-500/30">
                            <Sparkles className="h-3 w-3 text-amber-400" />
                            {allDetectedReps.length} Reps on board {vehicle.repName ? `· Active: ${vehicle.repName}` : '(Choose 1)'}
                          </span>
                        ) : detectedOfficialRep ? (
                          <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px] flex items-center gap-1">
                            <Sparkles className="h-3 w-3 text-crimson-400" />
                            {vehicle.repName === detectedOfficialRep ? 'Rep:' : 'Official Rep:'} {detectedOfficialRep} {repStruct ? `(${repStruct})` : ''}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted">
                        {vehicle.type} · {riders.length} passenger{riders.length !== 1 ? 's' : ''}
                        {vehicle.repName ? ` · Rep: ${vehicle.repName}${repStruct ? ` (${repStruct})` : ''}` : ''}
                        {vehicle.licensePlate ? ` · Plate: ${vehicle.licensePlate}` : ''}
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2">
                    {riders.length > 0 && (
                      <button
                        onClick={() => unassignAllFromVehicle(vehicle.id)}
                        title="Return all riders to unassigned pool"
                        className="btn-ghost px-2.5 py-2"
                      >
                        <Undo2 className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => removeVehicle(vehicle.id)}
                      title="Delete vehicle"
                      className="rounded-lg border border-crimson-500/20 bg-crimson-900/20 p-2 text-crimson-300 transition-all hover:border-crimson-500 hover:bg-crimson-900/40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-line bg-bg/40 p-4 animate-fade-in">
                    {/* Rep assignment & Smart Auto-Allocation */}
                    <div className="mb-4 space-y-2">
                      <div className="flex items-center gap-2">
                        <UserCog className="h-4 w-4 text-muted" />
                        <label className="text-[10px] font-semibold uppercase tracking-wide text-muted">Transport Rep</label>
                        <DebouncedInput
                          value={vehicle.repName ?? ''}
                          onChange={(val) => setRepName(vehicle.id, val)}
                          placeholder="Type rep name or select below"
                          className="input-field flex-1 py-1.5 text-xs"
                        />
                      </div>

                      {/* Compact inline rep picker when reps are detected */}
                      {allDetectedReps.length > 1 ? (
                        <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-xs">
                          <span className="text-[11px] font-semibold text-amber-300 flex items-center gap-1">
                            <Sparkles className="h-3 w-3 text-amber-400" />
                            {allDetectedReps.length} Reps:
                          </span>
                          {allDetectedReps.map(({ rep, rider }) => {
                            const isSelected = isPassengerRepOfVehicle(rider, vehicle.repName);
                            return (
                              <button
                                key={rep.fullName}
                                type="button"
                                onClick={() => setRepName(vehicle.id, isSelected ? '' : rep.fullName)}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                                  isSelected
                                    ? 'bg-crimson-600 text-white font-bold shadow-sm'
                                    : 'bg-card border border-line text-ink hover:border-amber-400/50'
                                }`}
                                title={isSelected ? 'Active rep (click to unassign)' : `Assign ${rep.fullName} (${rep.structure})`}
                              >
                                <span>{isSelected ? '★' : '☆'}</span>
                                <span>{rep.fullName}</span>
                                <span className="font-mono text-[10px] opacity-75">({rep.structure})</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : allDetectedReps.length === 1 && vehicle.repName !== allDetectedReps[0].rep.fullName ? (
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-crimson-500/20 bg-crimson-500/5 px-2.5 py-1 text-xs">
                          <span className="text-[11px] text-crimson-300">
                            Rep on board: <strong className="text-ink">{allDetectedReps[0].rep.fullName}</strong> ({allDetectedReps[0].rep.structure})
                          </span>
                          <button
                            type="button"
                            onClick={() => setRepName(vehicle.id, allDetectedReps[0].rep.fullName)}
                            className="btn-crimson py-0.5 px-2 text-[10px] whitespace-nowrap"
                          >
                            Set
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {/* Redirect / general note */}
                    <div className="mb-4 flex items-center gap-2">
                      <StickyNote className="h-4 w-4 text-muted" />
                      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap">Redirect Note</label>
                      <DebouncedInput
                        value={vehicle.generalNotes ?? ''}
                        onChange={(val) => setVehicleNote(vehicle.id, val)}
                        placeholder="e.g. Student Digzz people please Go to YMCA"
                        className="input-field flex-1 py-1.5 text-xs"
                      />
                    </div>

                    {/* Assign controls with Atomic Sub-Stop Grouping */}
                    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
                          {vehicle.type === 'Taxi' ? 'Hub Pool (Consolidated)' : 'Stop Pool'}
                        </label>
                        <select
                          value={selectedPoolKey}
                          onChange={(e) => setSelectedPoolKey(e.target.value)}
                          className="input-field py-2 text-xs"
                        >
                          <option value="" className="bg-card-2">Select {vehicle.type === 'Taxi' ? 'hub' : 'stop'}...</option>
                          {pool.map(({ key, count }) => (
                            <option key={key} value={key} className="bg-card-2">
                              {key} ({count} remaining)
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-24">
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Qty</label>
                        <input
                          type="number"
                          min="1"
                          value={assignQty}
                          onChange={(e) => setAssignQty(e.target.value)}
                          placeholder="all"
                          className="input-field py-2 text-xs"
                        />
                      </div>
                      <button
                        onClick={() => assignToVehicle(
                          vehicle.id,
                          selectedPoolKey,
                          assignQty ? Math.max(1, parseInt(assignQty, 10) || 1) : 'all'
                        )}
                        disabled={!selectedPoolKey}
                        className="btn-success py-2 text-xs"
                        title="Assign with atomic sub-stop preservation"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        Assign
                      </button>
                    </div>

                    {/* Rider list — grouped by stop/hub with Re-orderable Route Sequencing Controls */}
                    {riders.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted">No passengers assigned to this vehicle yet.</p>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between text-[11px] text-muted border-b border-line pb-1">
                          <span className="flex items-center gap-1 font-semibold uppercase tracking-wider text-muted">
                            <ArrowUpDown className="h-3 w-3" />
                            Route Sequence ({groups.length} stops)
                          </span>
                          <span>Re-order stops using ▲ / ▼</span>
                        </div>

                        {groups.map((group, groupIdx) => {
                          const isFirst = groupIdx === 0;
                          const isLast = groupIdx === groups.length - 1;

                          return (
                            <div key={group.label} className="rounded-xl border border-line bg-card/60 p-3">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <div className="flex items-center gap-1">
                                  {/* Shift controls */}
                                  <button
                                    type="button"
                                    onClick={() => moveStopOrder(vehicle.id, group.label, 'up')}
                                    disabled={isFirst}
                                    title="Move stop earlier in route sequence"
                                    className="rounded p-1 text-muted hover:bg-card-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                                  >
                                    <ChevronUp className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => moveStopOrder(vehicle.id, group.label, 'down')}
                                    disabled={isLast}
                                    title="Move stop later in route sequence"
                                    className="rounded p-1 text-muted hover:bg-card-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                                  >
                                    <ChevronDown className="h-4 w-4" />
                                  </button>
                                </div>

                                <MapPin className="h-3.5 w-3.5 text-crimson-400" />
                                <span className="text-xs font-bold uppercase tracking-wide text-crimson-300">{group.label}</span>
                                <span className="text-[10px] text-muted">({group.riders.length} riders)</span>

                                <span className="ml-auto flex items-center gap-1">
                                  <Clock className="h-3 w-3 text-muted" />
                                  <DebouncedInput
                                    type="time"
                                    value={vehicle.stopTimes?.[group.label] ?? ''}
                                    onChange={(val) => setStopTime(vehicle.id, group.label, val)}
                                    className="input-field w-24 py-0.5 text-[11px]"
                                    title="Pickup time for the WhatsApp export"
                                  />
                                </span>
                              </div>

                              <div className="space-y-1.5">
                                {group.riders.map((p) => {
                                  const isRepHighlight = highlightRep === p.fullName;
                                  const pOfficial = matchRiderToOfficialRep(p);
                                  const isVehicleRep = isPassengerRepOfVehicle(p, vehicle.repName);

                                  return (
                                    <div
                                      key={p.id}
                                      className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition-all cursor-pointer ${
                                        isVehicleRep
                                          ? 'border border-crimson-500/40 bg-crimson-500/10'
                                          : p.present
                                          ? 'bg-success/10'
                                          : 'bg-card-2/80'
                                      } ${isRepHighlight ? 'ring-2 ring-amber-400 shadow-md' : ''}`}
                                      onClick={() => setHighlightRep(highlightRep === p.fullName ? null : p.fullName)}
                                    >
                                      <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                                        <span className={`text-sm font-medium ${p.present ? 'text-success-light' : 'text-ink'}`}>
                                          {p.fullName}
                                        </span>

                                        {isVehicleRep ? (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRepName(vehicle.id, '');
                                            }}
                                            className="inline-flex items-center gap-1 rounded bg-crimson-500/25 px-2 py-0.5 text-xs font-bold text-crimson-300 border border-crimson-500/50 hover:bg-crimson-500/40 transition-colors"
                                            title="Designated Transport Rep for this vehicle (Click to unassign)"
                                          >
                                            ★ Active Rep
                                          </button>
                                        ) : pOfficial ? (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRepName(vehicle.id, pOfficial.fullName);
                                            }}
                                            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 hover:border-amber-400 transition-all active:scale-95 shadow-sm"
                                            title={`Click to designate ${pOfficial.fullName} (${pOfficial.structure}) as the vehicle rep`}
                                          >
                                            ☆ Pick as Rep ({pOfficial.structure})
                                          </button>
                                        ) : null}

                                        {p.structure && !pOfficial && (
                                          <span className="rounded bg-bg/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted">{p.structure}</span>
                                        )}
                                        {p.category === 'Ushers' ? (
                                          <span className="badge bg-amber-500/15 text-amber-300 text-[10px]">Usher (Early)</span>
                                        ) : p.category === 'Normal' ? (
                                          <span className="badge bg-sky-500/15 text-sky-300 text-[10px]">Normal</span>
                                        ) : p.ministry && p.ministry !== 'Serving' ? (
                                          <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px]">{p.ministry}</span>
                                        ) : null}
                                        <span className="badge bg-bg/60 text-muted text-[10px]">{p.stop}</span>
                                        {p.present && (
                                          <span className="badge bg-success/15 text-success-light text-[10px]">Present</span>
                                        )}
                                        {p.sponsored && (
                                          <span className="badge bg-warning/15 text-warning text-[10px]">Sponsored</span>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-1">
                                        {localManifest.vehicles.length >= 2 && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setMoveFromVehicle(vehicle.id);
                                              setMovePassengerId(p.id);
                                              setMoveToVehicle('');
                                              const el = document.getElementById('move-passenger-section');
                                              if (el) {
                                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                              }
                                            }}
                                            className={`rounded p-1 text-[11px] transition-all ${
                                              isVehicleRep || pOfficial
                                                ? 'text-amber-400 hover:text-amber-200 hover:bg-amber-500/20'
                                                : 'text-muted hover:text-ink hover:bg-bg/60'
                                            }`}
                                            title={isVehicleRep || pOfficial ? `Move Rep (${p.fullName}) to another taxi/bus` : 'Move to another vehicle'}
                                          >
                                            <MoveRight className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {!isVehicleRep && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRepName(vehicle.id, p.fullName);
                                            }}
                                            className="rounded p-1 text-[11px] text-muted hover:text-ink hover:bg-bg/60 transition-all"
                                            title="Make this passenger vehicle rep"
                                          >
                                            <UserCheck className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            unassignRider(vehicle.id, p.id);
                                          }}
                                          className="rounded-md p-1.5 text-muted transition-colors hover:bg-crimson-900/40 hover:text-crimson-300 active:scale-95"
                                          title="Return to pool"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Submitted vehicles accordion */}
      {submittedVehicles.length > 0 && (
        <div className="mt-5 overflow-hidden rounded-xl border border-success/20 bg-success/5">
          <button
            onClick={() => setShowSubmitted(!showSubmitted)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-success/10"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success-light" />
              <span className="text-xs font-semibold uppercase tracking-wide text-success-light">
                Submitted Vehicles ({submittedVehicles.length})
              </span>
            </div>
            {showSubmitted ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
          </button>
          {showSubmitted && (
            <div className="divide-y divide-line/60 border-t border-success/20 animate-fade-in">
              {submittedVehicles.map((v) => {
                const vRiders = riderPassengers(v);
                const vPresent = vRiders.filter((r) => r.present).length;
                return (
                  <div key={v.id} className="p-4">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                        v.type === 'Bus' ? 'bg-crimson-500/15 text-crimson-400' : 'bg-success/15 text-success-light'
                      }`}>
                        {v.type === 'Bus' ? <Bus className="h-4 w-4" /> : <Car className="h-4 w-4" />}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-ink">{v.name}</div>
                        <div className="text-xs text-muted">
                          {'Rep: ' + (v.repName || v.submittedBy || '—')}
                          {v.licensePlate ? ' · Plate: ' + v.licensePlate : ''}
                          {v.submittedAt ? ' · ' + new Date(v.submittedAt).toLocaleString('en-ZA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-display text-sm font-bold text-success-light">{vPresent}/{vRiders.length}</div>
                        <div className="text-[10px] text-muted">present</div>
                      </div>
                    </div>
                    {v.generalNotes && (
                      <div className="mt-2 rounded-lg bg-card-2/60 px-3 py-2 text-xs text-muted">
                        <span className="font-semibold text-ink">Notes: </span>{v.generalNotes}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

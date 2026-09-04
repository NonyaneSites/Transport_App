export interface Passenger {
  id: string;
  fullName: string;
  stop: string;
  structure: string;
  phone?: string;
  userEmail?: string;
  timestamp?: string;
  hub?: string;
  service?: string;
  category?: 'Ushers' | 'Serving' | 'Normal';
  ministry?: string;
  memberType?: 'M' | 'V' | 'FTV';
  assignedTo: string | null;
  present: boolean;
  cancellationFeeOwed: boolean;
  sponsored?: boolean;
  sponsorNote?: string;
  didNotPay?: boolean;
  unpaidNote?: string;
}

/**
 * Returns the badge details to render for a passenger, respecting the strict precedence:
 * 1. Early Serving Usher ('Usher (Early)') always takes top priority.
 * 2. Membership status ('FTV', 'V', 'M') takes precedence over generic serving ministries.
 * 3. Specific serving ministry (if not 'Serving' or empty) is shown if no memberType is set.
 * 4. Normal / default status.
 */
export function getPassengerStatusBadge(p?: Partial<Passenger> | null): {
  code: string;
  label: string;
  colorClass: string;
  title: string;
} | null {
  if (!p) return null;

  // 1. Early Serving Usher holds permanent priority
  if (p.category === 'Ushers') {
    return {
      code: 'USHER',
      label: 'Usher (Early)',
      colorClass: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
      title: 'Early Serving Usher',
    };
  }

  // 2. Member / Visitor / First Time Visitor status holds precedence over serving ministries
  if (p.memberType === 'FTV') {
    return {
      code: 'FTV',
      label: 'FTV',
      colorClass: 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40',
      title: 'First Time Visitor',
    };
  }
  if (p.memberType === 'V') {
    return {
      code: 'V',
      label: 'V',
      colorClass: 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/40',
      title: 'Visitor',
    };
  }
  if (p.memberType === 'M') {
    return {
      code: 'M',
      label: 'M',
      colorClass: 'bg-sky-500/20 text-sky-300 font-bold border border-sky-500/40',
      title: 'Member',
    };
  }

  // 3. Fallback to specific serving ministry if present
  if (p.ministry && p.ministry !== 'Serving') {
    return {
      code: 'MINISTRY',
      label: p.ministry,
      colorClass: 'bg-crimson-500/15 text-crimson-300 border border-crimson-500/30',
      title: p.ministry,
    };
  }

  // 4. Normal
  if (p.category === 'Normal') {
    return {
      code: 'NORMAL',
      label: 'Normal',
      colorClass: 'bg-sky-500/15 text-sky-300 border border-sky-500/25',
      title: 'Normal Transport',
    };
  }

  return null;
}

/**
 * Live, cross-device attendance state for a single vehicle's Rep Portal
 * session — persisted directly on the manifest row (via `Vehicle.draftState`)
 * and backed by localStorage, so the same check-in session stays in sync
 * across every device/tab a Rep has open, survives a refresh, and preserves
 * all marked absentees and present riders upon submission and reopening.
 */
export interface VehicleDraftState {
  presentIds?: string[];
  absentIds?: string[];
  sponsoredIds?: string[];
  unpaidIds?: string[]; // IDs of riders who rode but did not pay (unpaid fare)
  notes?: Record<string, string>; // passengerId -> note string
  repName?: string;
  coReps?: string[];
  licensePlate?: string;
  generalNotes?: string;
  cashCollected?: Record<string, number>;
  settledLedgerIds?: string[]; // historical debt IDs selected for settlement
  /**
   * Manual cancellation fees paid in cash (e.g. when passenger is not on the ledger yet).
   */
  manualCancellations?: { id: string; passengerName: string; structure?: string; amount: number; note?: string }[];
  /**
   * Cash-calculator sponsees paying for a passenger riding in a different
   * vehicle. Not covered by `cashCollected` (which only holds numeric
   * totals), so the full entries are kept here to round-trip the
   * calculator's name/vehicle/amount fields across devices.
   */
  externalSponsees?: { id: string; sponseeName: string; taxiName: string; amount: number }[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface Vehicle {
  id: string;
  name: string;
  type: 'Bus' | 'Taxi';
  riders: string[];
  /**
   * Chronological order in which stops/hubs were assigned to this vehicle.
   * For Taxis this stores hub labels (e.g. "Braam"); for Buses it stores raw
   * stop names (e.g. "56 Jorissen"). The UI and WhatsApp export MUST render
   * groups in this order — never alphabetical or by passenger count.
   */
  orderedStops?: string[];
  submitted?: boolean;
  submittedAt?: string;
  submittedBy?: string;
  licensePlate?: string;
  repName?: string;
  coReps?: string[];
  generalNotes?: string;
  repCount?: number;
  /**
   * Manually-set pickup time (e.g. "15:00") per stop/hub label, keyed the
   * same way as `orderedStops` entries. Used to render bold times in the
   * WhatsApp export (e.g. "🛑 Braam - *15:00*"). A label with no entry here
   * is exported without a time.
   */
  stopTimes?: Record<string, string>;
  /**
   * Stop Redirects: Maps source stop/hub names to target stop/hub names (e.g. { 'Saratoga': 'DFC bus stop' }).
   * When configured, passengers originally from the source stop are aggregated into the target stop's count,
   * while clearly retaining their source stop origin in rep checklists, vehicle cards, and WhatsApp exports.
   */
  stopRedirects?: Record<string, string>;
  /**
   * In-progress, not-yet-submitted attendance for this vehicle, synced
   * live via Supabase Realtime so any device editing this vehicle's Rep
   * Portal session sees the same state. See VehicleDraftState. Undefined
   * once there's no unsaved draft (e.g. after submission).
   */
  draftState?: VehicleDraftState;
}

export interface Manifest {
  date: string;
  signups: Passenger[];
  vehicles: Vehicle[];
  created_at?: string;
  updated_at?: string;
}

export type LiveSyncAction =
  | {
      type: 'rider_attendance';
      vehicleId: string;
      riderId: string;
      status: 'present' | 'absent' | 'unticked';
      repName: string;
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'rider_sponsored';
      vehicleId: string;
      riderId: string;
      sponsored: boolean;
      repName: string;
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'rider_unpaid';
      vehicleId: string;
      riderId: string;
      unpaid: boolean;
      repName: string;
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'rider_note';
      vehicleId: string;
      riderId: string;
      note: string;
      repName: string;
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'metadata_change';
      vehicleId: string;
      repName?: string;
      licensePlate?: string;
      generalNotes?: string;
      clientId: string;
      timestamp: number;
    }
  | {
      type: 'presence_heartbeat';
      vehicleId: string;
      repName: string;
      clientId: string;
      timestamp: number;
    };

export interface LiveRiderIndicator {
  author: string;
  status: string;
  timestamp: number;
}

export type ServiceType =
  | 'AM_Serving'
  | 'AM_Ushers'
  | 'AM_Normal'
  | 'PM_Serving'
  | 'PM_Normal';

export const SERVICE_TYPES: { value: ServiceType; label: string; period: 'AM' | 'PM'; mode: 'Serving' | 'Normal' | 'Ushers' }[] = [
  { value: 'AM_Serving', label: 'AM Service — Serving Only', period: 'AM', mode: 'Serving' },
  { value: 'AM_Ushers', label: 'AM Service — Ushers (Early)', period: 'AM', mode: 'Ushers' },
  { value: 'AM_Normal', label: 'AM Service — Normal Only', period: 'AM', mode: 'Normal' },
  { value: 'PM_Serving', label: 'PM Service — Serving Only', period: 'PM', mode: 'Serving' },
  { value: 'PM_Normal', label: 'PM Service — Normal Only', period: 'PM', mode: 'Normal' },
];

export const RESET_PASSWORD = 'CRC2026!';
export const CANCELLATION_FEE = 40;
export const MIN_TAXI_THRESHOLD = 15;

export const LARGE_BUS_THRESHOLD = 40;

/**
 * Strict Master Hub mapping (TAXI-only route consolidation — a taxi
 * physically gathers passengers from several distinct addresses at one
 * pickup point).
 *
 * Braam        -> 56 Jorissen, Amani, Apex, Student Digzz, YMCA
 * Gate 7       -> Amic Deck - David Webster, Barnato, Amic Deck - Men's Res,
 *                 Amic Deck - Sunnyside, Amic Deck - Jubilee (ALL Amic Deck
 *                 stops + Barnato)
 * EOH          -> Campus Central - EOH, EOH Campus Central, EOH
 *
 * Everything else (Yale, Stanley, UJ Bunting, Ghandi Square, Focus 1,
 * Maboneng, Urban Circle, DFC Bus Stop, The Fields, Laborie, Richmond,
 * Gate 2, Gate 4, APK McDonald's, Westdene, Junction, Education Campus,
 * Saratoga, Argyle, Arteria, Knockando) remains an individual stop and is
 * NEVER folded into a Taxi hub.
 *
 * NOTE: hub membership is about which stops are consolidated under one
 * label for display/allocation purposes — it does NOT mean a hub must be
 * assigned to a vehicle all-or-nothing. The Admin can still assign a
 * partial quantity out of a hub's (or a raw stop's) waiting pool to one
 * vehicle and leave the remainder for another (see the quantity selector
 * in VehicleAllocation).
 */
export const TAXI_HUBS: { hub: string; stops: string[] }[] = [
  {
    hub: 'Braam',
    stops: [
      '56 Jorissen',
      'Amani',
      'Apex',
      'Solomon Mahlangu',
      'Student Digzz',
      'YMCA',
    ],
  },
  {
    hub: 'Gate 7',
    stops: [
      'Amic Deck - David Webster',
      'Barnato',
      'Amic Deck - David Webster, Barnato',
      "Amic Deck - Men's Res",
      'Amic Deck - Sunnyside',
      'Amic Deck - Jubilee',
    ],
  },
  {
    hub: 'EOH',
    stops: [
      'Campus Central - EOH',
      'Campus Central -EOH',
      'EOH Campus Central',
      'EOH',
    ],
  },
];

/**
 * BUS-only spelling/name canonicalization. This is NOT route consolidation
 * (a Bus still drives to one physical address per stop) — it exists purely
 * because Microsoft Forms submissions have referred to the same EOH campus
 * address inconsistently across intakes ("Campus Central - EOH").
 * Charlotte Maxeke is kept completely separate and never merged into EOH.
 * Every other Bus stop (including Campus Central on Empire) remains untouched
 * and fully explicit.
 */
export const BUS_EOH_ALIASES = new Set([
  'Campus Central - EOH',
  'Campus Central -EOH',
  'EOH Campus Central',
  'EOH',
]);

/** Returns 'EOH' if this stop is a known Bus spelling-variant of the EOH campus address, else null. */
export function stopToBusHub(stop?: string | null): string | null {
  if (!stop) return null;
  const norm = stop.trim().toLowerCase();
  // Campus Central on Empire is standalone, NOT EOH!
  if (norm.includes('empire')) {
    return null;
  }
  // Charlotte Maxeke is separate, NOT EOH!
  if (norm.includes('charlotte')) {
    return null;
  }
  for (const alias of BUS_EOH_ALIASES) {
    if (alias.toLowerCase() === norm) return 'EOH';
  }
  if ((norm.includes('campus central') && norm.includes('eoh')) || norm === 'eoh' || norm.includes('eoh')) {
    return 'EOH';
  }
  return null;
}

export const INDIVIDUAL_STOPS = [
  'Yale', 'Stanley', 'Stanley Ave', 'UJ Bunting', 'Ghandi Square',
  'Focus 1', 'Maboneng', 'Urban Circle', 'DFC Bus Stop', 'DFC bus stop', 'The Fields',
  'Laborie', 'Richmond', 'Gate 2', 'Gate 4', "APK McDonald's", 'Westdene', 'Westdene Engen',
  'Junction', 'Education Campus', 'Education campus', 'Saratoga', 'Argyle', 'Arteria', 'Knockando',
  'Charlotte Maxeke', 'Charlotte',
  'Solomon Mahlangu',
  'Randburg Surrey Square',
  'Campus Central on empire', 'Campus Central (on Empire)', 'Campus Central (on empire)', 'Campus Central - Empire', 'Campus Central Empire',
] as const;

export const MASTER_HUBS = ['Braam', 'Gate 7', 'EOH'] as const;

/** Returns the Master Hub for a given stop, or null if the stop is not part of any hub (Buses always use the raw stop). */
export function stopToHub(stop?: string | null): string | null {
  if (!stop) return null;
  const norm = stop.trim().toLowerCase();
  for (const h of TAXI_HUBS) {
    if (h.stops.some((s) => s.toLowerCase() === norm)) {
      return h.hub;
    }
  }
  // Gate 7 combined stop options or Amic Deck variations
  if (
    norm.includes('david webster') ||
    norm.includes('barnato') ||
    (norm.includes('amic deck') && (norm.includes('jubilee') || norm.includes('sunnyside') || norm.includes("men's res") || norm.includes('mens res')))
  ) {
    return 'Gate 7';
  }
  // Campus Central on Empire is standalone, NOT EOH!
  if (norm.includes('empire')) {
    return null;
  }
  // Charlotte Maxeke is separate, NOT EOH!
  if (norm.includes('charlotte')) {
    return null;
  }
  // EOH variations
  if ((norm.includes('campus central') && norm.includes('eoh')) || norm === 'eoh' || norm.includes('eoh')) {
    return 'EOH';
  }
  return null;
}

/**
 * Display grouping key for a passenger's stop, based on vehicle type.
 * - Taxi: consolidated Master Hub (falls back to the raw stop if it isn't
 *   part of any hub, e.g. "Yale", "Campus Central on empire", "Charlotte Maxeke").
 * - Bus: the raw, explicit sub-stop — buses physically drive to each
 *   individual address and are never route-consolidated — EXCEPT:
 *   1. Known EOH spelling variants (see BUS_EOH_ALIASES), which canonicalize to "EOH".
 *   2. "Apex" which automatically names to "Solomon Mahlangu" in a Bus.
 *   3. "Charlotte Maxeke" is kept separate from EOH.
 */
export function hubDisplayName(vehicleType: 'Bus' | 'Taxi', stop?: string | null): string {
  if (!stop || stop.trim() === '' || stop.toLowerCase() === 'unknown' || stop.toLowerCase() === 'unspecified') {
    return 'Unassigned Stop';
  }
  const norm = stop.trim().toLowerCase();

  // In a Bus, Apex is automatically named Solomon Mahlangu
  if (vehicleType === 'Bus') {
    if (norm === 'apex' || norm.includes('apex') || norm === 'solomon mahlangu' || norm.includes('solomon mahlangu')) {
      return 'Solomon Mahlangu';
    }
    if (norm.includes('charlotte')) {
      return 'Charlotte Maxeke';
    }
    const busHub = stopToBusHub(stop);
    if (busHub) return busHub;
    return stop.trim();
  }

  // Taxi
  if (norm.includes('charlotte')) {
    return 'Charlotte Maxeke';
  }
  const hub = stopToHub(stop);
  if (hub) return hub;
  return stop.trim();
}

/**
 * Returns the effective stop label for a passenger in a vehicle,
 * accounting for admin stop redirects/merges (e.g. Saratoga -> DFC bus stop).
 */
export function getEffectiveStop(vehicle?: Vehicle | null, rawStop?: string | null): string {
  if (!rawStop) return 'Unassigned Stop';
  const vehType = vehicle?.type || 'Taxi';
  const baseLabel = hubDisplayName(vehType, rawStop);
  if (!vehicle || !vehicle.stopRedirects) return baseLabel;

  const redirects = vehicle.stopRedirects;
  // Direct match on baseLabel
  if (redirects[baseLabel] && redirects[baseLabel].trim()) {
    return redirects[baseLabel].trim();
  }
  // Direct match on rawStop
  if (redirects[rawStop] && redirects[rawStop].trim()) {
    return redirects[rawStop].trim();
  }
  // Case-insensitive match
  const lowerBase = baseLabel.toLowerCase();
  const lowerRaw = rawStop.toLowerCase();
  for (const [from, to] of Object.entries(redirects)) {
    if (to && to.trim() && (from.toLowerCase() === lowerBase || from.toLowerCase() === lowerRaw)) {
      return to.trim();
    }
  }
  return baseLabel;
}

/**
 * Canonical physical route sequence, used to order any stop/hub pool that
 * hasn't yet been locked into a vehicle's `orderedStops` (e.g. the Admin's
 * unassigned-pool overview, or a per-vehicle-type pool dropdown). This is
 * a fixed, defined order — it must NEVER be derived from signup counts.
 * Once a stop/hub is actually assigned to a vehicle, `orderedStops` takes
 * over as the source of truth for that vehicle's display order.
 */
export const ROUTE_SEQUENCE: string[] = [
  'Braam',
  '56 Jorissen', 'Amani', 'Apex', 'Solomon Mahlangu', 'Student Digzz', 'YMCA',
  'Gate 7',
  'Amic Deck - David Webster', 'Barnato', "Amic Deck - Men's Res", 'Amic Deck - Sunnyside', 'Amic Deck - Jubilee',
  'EOH',
  'Campus Central - EOH', 'EOH Campus Central',
  'Charlotte Maxeke', 'Charlotte',
  'Campus Central on empire', 'Campus Central (on Empire)', 'Campus Central (on empire)', 'Campus Central - Empire', 'Campus Central Empire',
  ...INDIVIDUAL_STOPS,
];

/** Index of a stop/hub label in the canonical route sequence (unknown labels sort last, in encounter order). */
export function routeSequenceIndex(key?: string | null): number {
  if (!key) return ROUTE_SEQUENCE.length;
  const norm = (key ?? '').trim().toLowerCase();
  const idx = ROUTE_SEQUENCE.findIndex((s) => s.toLowerCase() === norm);
  return idx === -1 ? ROUTE_SEQUENCE.length : idx;
}

/**
 * Sorts items by the canonical route sequence order — never by signup
 * count. Items not found in ROUTE_SEQUENCE are appended at the end,
 * preserving their relative input order.
 */
export function sortByRouteSequence<T>(items: T[], getKey: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, idx: routeSequenceIndex(getKey(item)) }))
    .sort((a, b) => (a.idx - b.idx) || (a.i - b.i))
    .map((x) => x.item);
}

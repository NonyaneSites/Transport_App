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
  assignedTo: string | null;
  present: boolean;
  cancellationFeeOwed: boolean;
  sponsored?: boolean;
  sponsorNote?: string;
}

/**
 * Live, cross-device attendance draft for a single vehicle's Rep Portal
 * session — persisted directly on the manifest row (via `Vehicle.draftState`)
 * instead of localStorage, so the same submission in progress stays in sync
 * across every device/tab a Rep has open, and survives a refresh or a
 * different device picking up where another left off. Cleared (set to
 * undefined) once the vehicle's attendance is actually submitted.
 */
export interface VehicleDraftState {
  presentIds?: string[];
  absentIds?: string[];
  sponsoredIds?: string[];
  notes?: Record<string, string>; // passengerId -> note string
  repName?: string;
  coReps?: string[];
  licensePlate?: string;
  generalNotes?: string;
  cashCollected?: Record<string, number>;
  settledLedgerIds?: string[]; // historical debt IDs selected for settlement
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

export type ServiceType =
  | 'AM_Serving'
  | 'AM_Normal'
  | 'PM_Serving'
  | 'PM_Normal';

export const SERVICE_TYPES: { value: ServiceType; label: string; period: 'AM' | 'PM'; mode: 'Serving' | 'Normal' }[] = [
  { value: 'AM_Serving', label: 'AM Service — Serving Only', period: 'AM', mode: 'Serving' },
  { value: 'AM_Normal', label: 'AM Service — Normal Only', period: 'AM', mode: 'Normal' },
  { value: 'PM_Serving', label: 'PM Service — Serving Only', period: 'PM', mode: 'Serving' },
  { value: 'PM_Normal', label: 'PM Service — Normal Only', period: 'PM', mode: 'Normal' },
];

export const RESET_PASSWORD = 'CRC2026!';
export const CANCELLATION_FEE = 40;

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
      'Student Digzz',
      'YMCA',
    ],
  },
  {
    hub: 'Gate 7',
    stops: [
      'Amic Deck - David Webster',
      'Barnato',
      "Amic Deck - Men's Res",
      'Amic Deck - Sunnyside',
      'Amic Deck - Jubilee',
    ],
  },
  {
    hub: 'EOH',
    stops: [
      'Campus Central - EOH',
      'EOH Campus Central',
      'EOH',
    ],
  },
];

/**
 * BUS-only spelling/name canonicalization. This is NOT route consolidation
 * (a Bus still drives to one physical address per stop) — it exists purely
 * because Microsoft Forms submissions have referred to the same EOH campus
 * address inconsistently across intakes ("Campus Central on empire",
 * "Campus Central - EOH", "Charlotte" / "Charlotte Maxeke"). All of these
 * canonicalize to the single stop name "EOH" for Buses so the sub-stop
 * breakdown doesn't fragment into duplicate rows for the same address.
 * Every other Bus stop remains untouched and fully explicit.
 */
export const BUS_EOH_ALIASES = new Set([
  'Campus Central on empire',
  'Campus Central - EOH',
  'Charlotte',
  'Charlotte Maxeke',
]);

/** Returns 'EOH' if this stop is a known Bus spelling-variant of the EOH campus address, else null. */
export function stopToBusHub(stop: string): string | null {
  const norm = stop.trim().toLowerCase();
  for (const alias of BUS_EOH_ALIASES) {
    if (alias.toLowerCase() === norm) return 'EOH';
  }
  return null;
}

export const INDIVIDUAL_STOPS = [
  'Yale', 'Stanley', 'UJ Bunting', 'Ghandi Square',
  'Focus 1', 'Maboneng', 'Urban Circle', 'DFC Bus Stop', 'The Fields',
  'Laborie', 'Richmond', 'Gate 2', 'Gate 4', "APK McDonald's", 'Westdene',
  'Junction', 'Education Campus', 'Saratoga', 'Argyle', 'Arteria', 'Knockando',
] as const;

export const MASTER_HUBS = ['Braam', 'Gate 7', 'EOH'] as const;

/** Returns the Master Hub for a given stop, or null if the stop is not part of any hub (Buses always use the raw stop). */
export function stopToHub(stop: string): string | null {
  for (const h of TAXI_HUBS) {
    if (h.stops.some((s) => s.toLowerCase() === stop.toLowerCase())) {
      return h.hub;
    }
  }
  return null;
}

/**
 * Display grouping key for a passenger's stop, based on vehicle type.
 * - Taxi: consolidated Master Hub (falls back to the raw stop if it isn't
 *   part of any hub, e.g. "Yale").
 * - Bus: the raw, explicit sub-stop — buses physically drive to each
 *   individual address and are never route-consolidated — EXCEPT the known
 *   EOH spelling variants (see BUS_EOH_ALIASES), which canonicalize to a
 *   single "EOH" stop since they're the same physical address.
 */
export function hubDisplayName(vehicleType: 'Bus' | 'Taxi', stop: string): string {
  if (vehicleType === 'Taxi') {
    const hub = stopToHub(stop);
    if (hub) return hub;
    return stop;
  }
  const busHub = stopToBusHub(stop);
  if (busHub) return busHub;
  return stop;
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
  '56 Jorissen', 'Amani', 'Apex', 'Student Digzz', 'YMCA',
  'Gate 7',
  'Amic Deck - David Webster', 'Barnato', "Amic Deck - Men's Res", 'Amic Deck - Sunnyside', 'Amic Deck - Jubilee',
  'EOH',
  'Campus Central - EOH', 'EOH Campus Central', 'Campus Central on empire', 'Charlotte', 'Charlotte Maxeke',
  ...INDIVIDUAL_STOPS,
];

/** Index of a stop/hub label in the canonical route sequence (unknown labels sort last, in encounter order). */
export function routeSequenceIndex(key: string): number {
  const norm = key.trim().toLowerCase();
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

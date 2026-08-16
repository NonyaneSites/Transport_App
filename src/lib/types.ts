export interface Passenger {
  id: string;
  fullName: string;
  stop: string;
  structure: string;
  assignedTo: string | null;
  present: boolean;
  cancellationFeeOwed: boolean;
  sponsored?: boolean;
  sponsorNote?: string;
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

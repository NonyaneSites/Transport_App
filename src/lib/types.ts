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
 * Strict Master Hub mapping (taxi-only consolidation).
 *
 * Braam        -> 56 Jorissen, Amani, Apex, Student Digzz, YMCA
 * Gate 7       -> ALL Amic Deck stops + Barnato
 * EOH          -> EOH, EOH Campus Central, Campus Central on empire
 *
 * Everything else (Yale, Stanley, UJ Bunting, Ghandi Square, Focus 1,
 * Maboneng, Urban Circle, DFC Bus Stop, The Fields, Laborie, Richmond,
 * Gate 2, Gate 4, APK McDonald's, Westdene, Junction, Education Campus,
 * Saratoga, Argyle, Arteria, Knockando) remains an individual stop and is
 * NEVER folded into a hub, for either Buses or Taxis.
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
      "Amic Deck - Men's Res",
      'Amic Deck - Jubilee',
      'Amic Deck - Sunnyside',
      'Amic Deck - David Webster',
      'Barnato',
    ],
  },
  {
    hub: 'EOH',
    stops: [
      'EOH',
      'EOH Campus Central',
      'Campus Central on empire',
    ],
  },
];

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
 * - Bus: always the raw, explicit sub-stop — buses physically drive to each
 *   individual address and must never be hub-consolidated.
 */
export function hubDisplayName(vehicleType: 'Bus' | 'Taxi', stop: string): string {
  if (vehicleType === 'Taxi') {
    const hub = stopToHub(stop);
    if (hub) return hub;
  }
  return stop;
}

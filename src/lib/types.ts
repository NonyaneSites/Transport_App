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
  submitted?: boolean;
  submittedAt?: string;
  submittedBy?: string;
  licensePlate?: string;
  repName?: string;
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

// Taxi gathering hub mappings — only applied when vehicle type is Taxi
export const TAXI_HUBS: { hub: string; stops: string[] }[] = [
  {
    hub: 'Braam Hub',
    stops: [
      '56 Jorissen',
      'Amani',
      "Amic Deck - Men's Res",
      'Amic Deck - Jubilee',
      'Amic Deck - Sunnyside',
      'Apex',
      'Student Digzz',
      'YMCA',
    ],
  },
  {
    hub: 'Gate 7 Hub',
    stops: [
      'Amic Deck - David Webster',
      'Barnato',
    ],
  },
  {
    hub: 'EOH Hub',
    stops: [
      'EOH Campus Central',
      'EOH',
      'Campus Central on empire',
    ],
  },
];

export function stopToHub(stop: string): string | null {
  for (const h of TAXI_HUBS) {
    if (h.stops.some((s) => s.toLowerCase() === stop.toLowerCase())) {
      return h.hub;
    }
  }
  return null;
}

export function hubDisplayName(vehicleType: 'Bus' | 'Taxi', stop: string): string {
  if (vehicleType === 'Taxi') {
    const hub = stopToHub(stop);
    if (hub) return hub;
  }
  return stop;
}

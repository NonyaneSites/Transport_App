/** Shared transport-upload normalization.
 *  Keep this function at the parser boundary so nothing dirty reaches persisted state.
 */
export function sanitizeTransportValue(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

// Strict Master Hub sets (TAXI route consolidation) — kept in lockstep with
// TAXI_HUBS in ./types.
// Braam consolidates ONLY these five stops.
const BRAAM = new Set(['56 Jorissen', 'Amani', 'Apex', 'Student Digzz', 'YMCA']);
// Gate 7 consolidates ALL Amic Deck stops + Barnato.
const GATE_7 = new Set([
  'Amic Deck - David Webster',
  'Barnato',
  'Amic Deck - David Webster, Barnato',
  "Amic Deck - Men's Res",
  'Amic Deck - Sunnyside',
  'Amic Deck - Jubilee',
]);
const EOH = new Set([
  'Campus Central - EOH',
  'Campus Central -EOH',
  'EOH Campus Central',
  'EOH',
]);

// BUS-only spelling canonicalization — same physical EOH address, various
// spellings across Forms intakes. Kept in lockstep with BUS_EOH_ALIASES in
// ./types. NOT route consolidation — see the note there.
export const BUS_EOH_ALIASES = new Set([
  'Campus Central - EOH',
  'Campus Central -EOH',
  'EOH Campus Central',
  'EOH',
]);

/**
 * Taxi Master Hub for a raw stop value, or the raw (sanitized) stop itself
 * if it isn't part of any hub. NOTE: this is exposed for callers that need
 * the taxi-consolidated name directly; the app's own routing/display logic
 * lives in hubDisplayName (./types), which additionally handles the
 * Bus-only EOH spelling canonicalization — use that instead of this
 * function wherever a vehicle-type-aware answer is needed.
 *
 * Hub membership only determines the consolidated *label* passengers are
 * grouped under — it does not force all-or-nothing assignment. The Admin
 * may still assign a partial quantity out of a hub's waiting pool to one
 * vehicle and leave the rest for another vehicle.
 */
export function masterHubForStop(value: unknown): string {
  const stop = sanitizeTransportValue(value);
  const norm = stop.toLowerCase();
  for (const s of BRAAM) {
    if (s.toLowerCase() === norm) return 'Braam';
  }
  for (const s of GATE_7) {
    if (s.toLowerCase() === norm) return 'Gate 7';
  }
  if (norm.includes('david webster') || norm.includes('barnato') || (norm.includes('amic deck') && (norm.includes('jubilee') || norm.includes('sunnyside') || norm.includes("men's res") || norm.includes('mens res')))) {
    return 'Gate 7';
  }
  // Campus Central on Empire is standalone, NOT EOH!
  if (norm.includes('empire')) {
    return stop;
  }
  // Charlotte Maxeke is separate, NOT EOH!
  if (norm.includes('charlotte')) {
    return 'Charlotte Maxeke';
  }
  for (const s of EOH) {
    if (s.toLowerCase() === norm) return 'EOH';
  }
  if ((norm.includes('campus central') && norm.includes('eoh')) || norm === 'eoh' || norm.includes('eoh')) {
    return 'EOH';
  }
  return stop;
}

export function sanitizePassengerRecord<T extends Record<string, unknown>>(passenger: T): T {
  const fullName = sanitizeTransportValue(passenger.fullName);
  const firstName = sanitizeTransportValue(passenger.firstName);
  const surname = sanitizeTransportValue(passenger.surname);
  // NOTE: `stop` here is intentionally kept as the RAW (sanitized) stop name,
  // not the master-hub name. Master-hub consolidation is a display/allocation
  // concern that differs between Buses and Taxis (see hubDisplayName in
  // ./types) and must never be baked into the persisted passenger record —
  // doing so would make it impossible to show Buses their explicit sub-stop
  // breakdown.
  const stop = sanitizeTransportValue(passenger.stop);
  return {
    ...passenger,
    fullName,
    firstName,
    surname,
    stop,
  };
}

export const MASTER_HUBS = ['Braam', 'Gate 7', 'EOH'] as const;

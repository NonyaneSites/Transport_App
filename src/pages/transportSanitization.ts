/** Shared transport-upload normalization.
 *  Keep this function at the parser boundary so nothing dirty reaches persisted state.
 */
export function sanitizeTransportValue(value: unknown): string {
  return String(value ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

const BRAAM = new Set([
  '56 Jorissen', 'Amani', "Amic Deck - Men’s Res", "Amic Deck - Men's Res",
  'Amic Deck - Jubilee', 'Amic Deck - Sunnyside', 'Apex', 'Student Digzz', 'YMCA',
]);
const GATE_7 = new Set(['Amic Deck - David Webster', 'Barnato']);
const EOH = new Set(['EOH Campus Central', 'Campus Central on empire']);

export function masterHubForStop(value: unknown): string {
  const stop = sanitizeTransportValue(value);
  if (BRAAM.has(stop)) return 'Braam';
  if (GATE_7.has(stop)) return 'Gate 7';
  if (EOH.has(stop)) return 'EOH';
  return stop;
}

export function sanitizePassengerRecord<T extends Record<string, any>>(passenger: T): T {
  const fullName = sanitizeTransportValue(passenger.fullName);
  const firstName = sanitizeTransportValue(passenger.firstName);
  const surname = sanitizeTransportValue(passenger.surname);
  const stop = masterHubForStop(passenger.stop);
  return {
    ...passenger,
    fullName,
    firstName,
    surname,
    stop,
  };
}

export const MASTER_HUBS = [
  'Braam', 'Gate 7', 'EOH', 'Yale', 'Stanley', 'UJ Bunting', 'Ghandi Square',
  'Focus 1', 'Maboneng', 'Urban Circle', 'DFC Bus Stop', 'The Fields', 'Laborie',
  'Richmond', 'Gate 2', 'Gate 4', "APK McDonald's", 'Westdene', 'Junction',
  'Education Campus', 'Saratoga', 'Argyle', 'Arteria', 'Knockando',
] as const;

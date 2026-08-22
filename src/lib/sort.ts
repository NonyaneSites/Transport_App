/**
 * True alphanumeric ("natural") comparator: compares string chunks
 * numerically, so "Taxi 1" < "Taxi 2" < "Taxi 10" (not "Taxi 1" < "Taxi 10" < "Taxi 2"),
 * and "Bus 1" < "Bus 2" < "Taxi 1".
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Vehicle cards and vehicle selection dropdowns MUST always render in
 * natural alphanumeric order by name (e.g. Bus 1, Bus 2, Taxi 1, Taxi 2, ..., Taxi 10)
 * — never by random creation order or submission state.
 */
export function sortVehiclesNatural<T extends { name: string }>(vehicles: T[]): T[] {
  return [...vehicles].sort((a, b) => naturalCompare(a.name, b.name));
}

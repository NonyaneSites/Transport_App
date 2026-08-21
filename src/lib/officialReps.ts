import type { Passenger } from './types';
import { sortByRouteSequence } from './types';

/**
 * Groups passengers by their explicit raw stop name, preserving whole sub-stop
 * clusters wherever possible and only splitting the final group if it overflows capacity.
 */
export function allocateSubStopsIntact(
  hubPassengers: Passenger[],
  requestedCount: number
): { allocated: Passenger[]; remaining: Passenger[] } {
  // Group passengers by explicit raw stop name
  const stopMap = new Map<string, Passenger[]>();
  hubPassengers.forEach((p) => {
    const key = p.stop || 'Unspecified';
    if (!stopMap.has(key)) stopMap.set(key, []);
    stopMap.get(key)!.push(p);
  });

  // Sort sub-stop groups in official route sequence order
  const sortedStops = sortByRouteSequence(Array.from(stopMap.keys()), (s) => s);

  const allocated: Passenger[] = [];
  const remaining: Passenger[] = [];
  let spaceLeft = requestedCount;

  for (const stopName of sortedStops) {
    const group = stopMap.get(stopName) ?? [];
    if (spaceLeft <= 0) {
      remaining.push(...group);
      continue;
    }
    if (group.length <= spaceLeft) {
      // Entire sub-stop group fits intact
      allocated.push(...group);
      spaceLeft -= group.length;
    } else {
      // Group exceeds remaining capacity: fill space and leave remainder
      allocated.push(...group.slice(0, spaceLeft));
      remaining.push(...group.slice(spaceLeft));
      spaceLeft = 0;
    }
  }

  return { allocated, remaining };
}
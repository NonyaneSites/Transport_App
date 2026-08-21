import type { Passenger } from './types';

/**
 * Allocates passengers while keeping sub-stop groups intact where possible.
 * Only splits a sub-stop group if its size exceeds the remaining vehicle capacity.
 */
export function allocateSubStopsIntact(
  hubPassengers: Passenger[],
  requestedCount: number
): { allocated: Passenger[]; remaining: Passenger[] } {
  const stopMap = new Map<string, Passenger[]>();
  hubPassengers.forEach((p) => {
    const key = p.stop || 'Unspecified';
    if (!stopMap.has(key)) stopMap.set(key, []);
    stopMap.get(key)!.push(p);
  });

  const allocated: Passenger[] = [];
  const remaining: Passenger[] = [];
  let spaceLeft = requestedCount;

  for (const [, group] of stopMap.entries()) {
    if (spaceLeft <= 0) {
      remaining.push(...group);
      continue;
    }
    if (group.length <= spaceLeft) {
      // Entire sub-stop group fits intact
      allocated.push(...group);
      spaceLeft -= group.length;
    } else {
      // Single sub-stop exceeds remaining capacity: partial overflow slice
      allocated.push(...group.slice(0, spaceLeft));
      remaining.push(...group.slice(spaceLeft));
      spaceLeft = 0;
    }
  }

  return { allocated, remaining };
}
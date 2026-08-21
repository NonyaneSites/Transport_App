import type { Passenger } from './types';

/**
 * Atomic Sub-Stop Grouping Allocation
 * Ensures passengers from the same specific sub-stop (e.g. "56 Jorissen", "Amic Deck - Men's Res")
 * stay together without being needlessly split across vehicles unless vehicle capacity is exceeded.
 */
export function allocateSubStopsIntact(
  hubPassengers: Passenger[],
  requestedCount: number
): { allocated: Passenger[]; remaining: Passenger[] } {
  // Group passengers by their explicit raw stop name
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
      // Group exceeds remaining capacity: fill space and leave remaining
      allocated.push(...group.slice(0, spaceLeft));
      remaining.push(...group.slice(spaceLeft));
      spaceLeft = 0;
    }
  }

  return { allocated, remaining };
}

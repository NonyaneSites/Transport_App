import type { Passenger } from './types';
import { sortByRouteSequence } from './types';

export const OFFICIAL_STRUCTURE_REPS: Record<string, string[]> = {
  S1: ['Nthabiseng Mosekedi', 'Nthabeleng Mosepele'],
  S2: ['Thuto Mokone'],
  S3: ['Rokunda Rambuda'],
  S5: ['Wandile Xaba', 'Tshoetso Mohlamonyane'],
  S6: ['Letlhohonolo Segalwe', 'Katlego Mokhele', 'Shaun Tsiloane'],
  S7: ['Cassey Lewis'],
  S9: ['Amogelang Nhlabathi'],
  S10: ['Lisakhanya Mbinda', 'Aphiwe Thusi'],
  S11: ['Neo Mokeona', 'Merica Nkabinde'],
  S13: ['Konanani Tshavhungwe'],
  S14: ['Kgolaganyo Modise', 'Nicole Nyezi'],
  S15: ['Mkateko Ngobeni', 'Katleho Skhosana', 'Kamogelo Seakamela'],
  S16: ['Nduvho Mulaudzi'],
  S18: ['Lalamani Manenzhe'],
  S19: ['Miyelani Nkuna'],
  S20: ['Mosima Mokgahlane'],
  S21: ['Sphesihle Jobe', 'Vhugala Mphaphuli'],
  S25: ['Anovuyo Mabutho'],
  S26: ['Kamogelo Pitje', 'Neo Malemela', 'Agnes Monyane', 'Gaven'],
};

export function detectVehicleRep(riders: { fullName: string; structure?: string }[]): string | null {
  for (const rider of riders) {
    const normRider = rider.fullName.trim().toLowerCase();
    for (const [_, reps] of Object.entries(OFFICIAL_STRUCTURE_REPS)) {
      for (const rep of reps) {
        if (normRider.includes(rep.toLowerCase()) || rep.toLowerCase().includes(normRider)) {
          return rep;
        }
      }
    }
  }
  return null;
}

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
      allocated.push(...group);
      spaceLeft -= group.length;
    } else {
      allocated.push(...group.slice(0, spaceLeft));
      remaining.push(...group.slice(spaceLeft));
      spaceLeft = 0;
    }
  }

  return { allocated, remaining };
}
}

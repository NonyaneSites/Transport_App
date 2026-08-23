export interface OfficialRep {
  fullName: string;
  structure: string;
  lastName: string;
  aliases: string[];
  role?: string;
}

export const ALL_OFFICIAL_REPS: OfficialRep[] = [
  // S1
  { fullName: 'Nthabiseng Mosekedi', structure: 'S1', lastName: 'Mosekedi', aliases: ['Nthabi Mosekedi'] },
  { fullName: 'Nthabeleng Mosepele', structure: 'S1', lastName: 'Mosepele', aliases: ['Nthabi Mosepele', 'Nthabe Mosepele'] },
  { fullName: 'Pako Mabe', structure: 'S1', lastName: 'Mabe', aliases: [], role: 'Area Rep - DFC/CBD' },

  // S2
  { fullName: 'Thuto Mokone', structure: 'S2', lastName: 'Mokone', aliases: [] },

  // S3
  { fullName: 'Rokunda Rambuda', structure: 'S3', lastName: 'Rambuda', aliases: ['Roki Rambuda'] },

  // S4 / Coordinators
  { fullName: 'Thuthukani Ndwandwe', structure: 'S4', lastName: 'Ndwandwe', aliases: ['Thuthu Ndwandwe'], role: 'Bus Coordinator / Area Rep' },
  { fullName: 'Thanyani Munotha', structure: 'S4', lastName: 'Munotha', aliases: ['Thanyani Jnr Munotha', 'Thanyani Jnr. Munotha'], role: 'Taxi Coordination' },

  // S5
  { fullName: 'Wandile Xaba', structure: 'S5', lastName: 'Xaba', aliases: ['Wandi Xaba'] },
  { fullName: 'Tshoetso Mohlamonyane', structure: 'S5', lastName: 'Mohlamonyane', aliases: [] },

  // S6
  { fullName: 'Letlhohonolo Segalwe', structure: 'S6', lastName: 'Segalwe', aliases: ['Hono Segalwe'] },
  { fullName: 'Katlego Mokhele', structure: 'S6', lastName: 'Mokhele', aliases: ['Kat Mokhele'] },
  { fullName: 'Shaun Tsiloane', structure: 'S6', lastName: 'Tsiloane', aliases: [] },

  // S7
  { fullName: 'Cassey Lewis', structure: 'S7', lastName: 'Lewis', aliases: ['Casey Lewis'] },

  // S9
  { fullName: 'Amogelang Nhlabathi', structure: 'S9', lastName: 'Nhlabathi', aliases: ['Amo Nhlabathi', 'Amogelang N', 'Amo N'] },
  { fullName: 'Neo Mokoena', structure: 'S9', lastName: 'Mokoena', aliases: ['Neo Mokeona'], role: 'Taxi Coordination' },

  // S10
  { fullName: 'Lisakhanya Mbinda', structure: 'S10', lastName: 'Mbinda', aliases: ['Lisa Mbinda'] },
  { fullName: 'Aphiwe Thusi', structure: 'S10', lastName: 'Thusi', aliases: ['Aphi Thusi'] },

  // S11
  { fullName: 'Merica Nkabinde', structure: 'S11', lastName: 'Nkabinde', aliases: [], role: 'Bus Coordinator' },

  // S13
  { fullName: 'Konanani Tshavhungwe', structure: 'S13', lastName: 'Tshavhungwe', aliases: ['Kona Tshavhungwe', 'Abigail Konanani Tshavhungwe'] },

  // S14
  { fullName: 'Kgolaganyo Modise', structure: 'S14', lastName: 'Modise', aliases: ['Kgola Modise'], role: 'Cancellations Admin' },
  { fullName: 'Nicole Nyezi', structure: 'S14', lastName: 'Nyezi', aliases: ['Nicole Nyez'] },
  { fullName: 'Mawande Buthelezi', structure: 'S14', lastName: 'Buthelezi', aliases: [], role: 'Area Rep - Auckland Park' },

  // S15
  { fullName: 'Mkateko Ngobeni', structure: 'S15', lastName: 'Ngobeni', aliases: ['Mikateko Ngobeni'] },
  { fullName: 'Katleho Skhosana', structure: 'S15', lastName: 'Skhosana', aliases: ['Kat Skhosana'] },
  { fullName: 'Kamogelo Seakamela', structure: 'S15', lastName: 'Seakamela', aliases: ['Kamo Seakamela'] },

  // S16
  { fullName: 'Nduvho Mulaudzi', structure: 'S16', lastName: 'Mulaudzi', aliases: [] },

  // S18
  { fullName: 'Lalamani Manenzhe', structure: 'S18', lastName: 'Manenzhe', aliases: [] },

  // S19
  { fullName: 'Miyelani Nkuna', structure: 'S19', lastName: 'Nkuna', aliases: ['Miye Nkuna'] },
  { fullName: 'Mbalenhle Mtshali', structure: 'S19', lastName: 'Mtshali', aliases: ['Mbali Mtshali'], role: 'Cancellations Admin' },

  // S20
  { fullName: 'Mosima Mokgahlane', structure: 'S20', lastName: 'Mokgahlane', aliases: ['Mosi Mokgahlane', 'Oratile Mokgahlane'] },

  // S21
  { fullName: 'Sphesihle Jobe', structure: 'S21', lastName: 'Jobe', aliases: ['Sphe Jobe'] },
  { fullName: 'Vhugala Mphaphuli', structure: 'S21', lastName: 'Mphaphuli', aliases: [] },

  // S25
  { fullName: 'Anovuyo Mabutho', structure: 'S25', lastName: 'Mabutho', aliases: ['Ano Mabutho'] },
  { fullName: 'Londiwe Jele', structure: 'S25', lastName: 'Jele', aliases: ['Londi Jele'], role: 'Taxi Coordination' },

  // S26
  { fullName: 'Kamogelo Pitje', structure: 'S26', lastName: 'Pitje', aliases: ['Kamo Pitje'], role: 'Finances' },
  { fullName: 'Neo Malemela', structure: 'S26', lastName: 'Malemela', aliases: [] },
  { fullName: 'Agnes Monyane', structure: 'S26', lastName: 'Monyane', aliases: [] },
  { fullName: 'Gaven', structure: 'S26', lastName: 'Gaven', aliases: [] },

  // Overseers & Area Leaders
  { fullName: 'Maanda Makhuvha', structure: 'Leadership', lastName: 'Makhuvha', aliases: [], role: 'Overseer' },
  { fullName: 'Bridget Miya', structure: 'Leadership', lastName: 'Miya', aliases: [], role: '2IC Admin + Planning' },
  { fullName: 'Refiloe Mobeng', structure: 'Leadership', lastName: 'Mobeng', aliases: [], role: '2IC Operations' },
  { fullName: 'Alice Chinyadza', structure: 'Finances', lastName: 'Chinyadza', aliases: [], role: 'Finances' },
  { fullName: 'Sthembiso Mkhize', structure: 'Area', lastName: 'Mkhize', aliases: ['Sthe Mkhize'], role: 'Area Rep - Braamfontein' },
  { fullName: 'Tetelo Mamaila', structure: 'Area', lastName: 'Mamaila', aliases: [], role: 'Area Rep - Main Campus' },
  { fullName: 'Angelique Makhikhi', structure: 'Area', lastName: 'Makhikhi', aliases: [], role: 'Area Rep - Park Town' },
];

export const OFFICIAL_STRUCTURE_REPS: Record<string, string[]> = ALL_OFFICIAL_REPS.reduce(
  (acc, rep) => {
    if (!acc[rep.structure]) acc[rep.structure] = [];
    if (!acc[rep.structure].includes(rep.fullName)) {
      acc[rep.structure].push(rep.fullName);
    }
    return acc;
  },
  {} as Record<string, string[]>
);

/**
 * Checks if a specific rider is an official transport rep based on:
 * 1. Structure + Last Name matching (e.g. S9 Amo Nhlabathi matches S9 Amogelang Nhlabathi)
 * 2. Full Name / Alias matching (e.g. "Amo Nhlabathi", "Shaun Tsiloane")
 * 3. Last name + known nickname matching
 */
export function matchRiderToOfficialRep(rider?: {
  fullName?: string;
  structure?: string;
} | null): OfficialRep | null {
  if (!rider || !rider.fullName) return null;
  const normName = (rider.fullName || '').trim().toLowerCase();
  if (!normName) return null;

  const rawStruct = (rider.structure ?? '').trim().toUpperCase().replace(/\s+/g, '');

  // 1. Structure is present: STRICT matching required!
  // Both structure AND exact full name or exact registered alias must match.
  if (rawStruct) {
    for (const rep of ALL_OFFICIAL_REPS) {
      if (rep.structure.toUpperCase() === rawStruct) {
        const repFullName = rep.fullName.toLowerCase();

        // Exact full name match in this structure
        if (normName === repFullName) {
          return rep;
        }

        // Strict official alias match in this structure
        if (rep.aliases.some((a) => a.toLowerCase() === normName)) {
          return rep;
        }
      }
    }
    // If rider explicitly has a structure that did not match the rep of that structure, do NOT match a different structure's rep!
    return null;
  }

  // 2. No structure provided on rider: match ONLY by exact full name or strict registered aliases
  for (const rep of ALL_OFFICIAL_REPS) {
    const repFullNameNorm = rep.fullName.toLowerCase();
    if (normName === repFullNameNorm) {
      return rep;
    }
    // Full-name alias match
    for (const alias of rep.aliases) {
      const normAlias = alias.toLowerCase();
      if (normName === normAlias) {
        return rep;
      }
    }
  }

  return null;
}

/**
 * Returns all detected official reps among vehicle riders.
 */
export interface DetectedRepOnBoard {
  rep: OfficialRep;
  rider: { fullName: string; structure?: string };
}

export function detectAllVehicleReps(
  riders?: { fullName: string; structure?: string }[] | null
): DetectedRepOnBoard[] {
  if (!Array.isArray(riders)) return [];
  const seenCanonical = new Set<string>();
  const detected: DetectedRepOnBoard[] = [];

  for (const rider of riders) {
    if (!rider || !rider.fullName) continue;
    const match = matchRiderToOfficialRep(rider);
    if (match && !seenCanonical.has(match.fullName)) {
      seenCanonical.add(match.fullName);
      detected.push({ rep: match, rider });
    }
  }
  return detected;
}

/**
 * Returns the canonical name of an official rep if one is present among vehicle riders.
 */
export function detectVehicleRep(
  riders?: { fullName: string; structure?: string }[] | null
): string | null {
  if (!Array.isArray(riders)) return null;
  const all = detectAllVehicleReps(riders);
  return all.length > 0 ? all[0].rep.fullName : null;
}

/**
 * Determines if a specific passenger is the designated Transport Rep for a vehicle.
 */
export function isPassengerRepOfVehicle(
  passenger?: { fullName?: string; structure?: string } | null,
  repName?: string | null
): boolean {
  if (!passenger || !passenger.fullName || !repName) return false;
  const normRep = repName.trim().toLowerCase();
  const normPass = (passenger.fullName || '').trim().toLowerCase();
  if (!normRep || !normPass) return false;

  // 1. Direct name match
  if (normPass === normRep) return true;

  // 2. Canonical official rep match
  const repOfficial = matchRiderToOfficialRep({ fullName: repName });
  const passOfficial = matchRiderToOfficialRep({ fullName: passenger.fullName, structure: passenger.structure });

  if (repOfficial && passOfficial && repOfficial.fullName.toLowerCase() === passOfficial.fullName.toLowerCase()) {
    return true;
  }
  if (repOfficial && normPass === repOfficial.fullName.toLowerCase()) {
    return true;
  }
  if (passOfficial && normRep === passOfficial.fullName.toLowerCase()) {
    return true;
  }

  // 3. Check aliases
  if (repOfficial) {
    if (repOfficial.aliases.some((a) => a.toLowerCase() === normPass)) {
      return true;
    }
  }

  return false;
}

/**
 * Find structure code for an official rep
 */
export function getRepStructure(repName?: string | null): string | null {
  if (!repName) return null;
  const match = matchRiderToOfficialRep({ fullName: repName });
  if (match) return match.structure;

  const norm = repName.trim().toLowerCase();
  for (const rep of ALL_OFFICIAL_REPS) {
    if (
      rep.fullName.toLowerCase() === norm ||
      rep.aliases.some((a) => a.toLowerCase() === norm) ||
      rep.lastName.toLowerCase() === norm
    ) {
      return rep.structure;
    }
  }
  return null;
}


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

// Returns the name of an official rep if one is present among vehicle riders
export function detectVehicleRep(riders: { fullName: string; structure?: string }[]): string | null {
  for (const rider of riders) {
    const normRider = rider.fullName.trim().toLowerCase();

    // Check against all official rep names
    for (const [, reps] of Object.entries(OFFICIAL_STRUCTURE_REPS)) {
      for (const rep of reps) {
        if (normRider.includes(rep.toLowerCase()) || rep.toLowerCase().includes(normRider)) {
          return rep;
        }
      }
    }
  }
  return null;
}

// Find structure code for an official rep
export function getRepStructure(repName: string): string | null {
  const norm = repName.trim().toLowerCase();
  for (const [struct, reps] of Object.entries(OFFICIAL_STRUCTURE_REPS)) {
    for (const rep of reps) {
      if (norm.includes(rep.toLowerCase()) || rep.toLowerCase().includes(norm)) {
        return struct;
      }
    }
  }
  return null;
}

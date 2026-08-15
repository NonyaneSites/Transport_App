/**
 * True alphanumeric ("natural") comparator: splits each string into
 * digit / non-digit runs and compares digit runs numerically, so
 * "S1" < "S2" < "S9" < "S13" (not "S1" < "S13" < "S2" < "S9" as
 * plain string/localeCompare sorting would give).
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) ?? [a];
  const bParts = b.match(re) ?? [b];
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? '';
    const bp = bParts[i] ?? '';
    if (ap === bp) continue;

    const aNum = /^\d+$/.test(ap) ? parseInt(ap, 10) : NaN;
    const bNum = /^\d+$/.test(bp) ? parseInt(bp, 10) : NaN;

    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
      continue;
    }
    return ap.localeCompare(bp);
  }
  return 0;
}

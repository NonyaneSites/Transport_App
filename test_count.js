// Let's test the date parsing logic on "13 September 2026", "23 August 2026", "06 September 2026", "30 August 2026"
const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function parseDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const monMatch = str.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (monMatch) {
    const day = parseInt(monMatch[1], 10);
    const monName = monMatch[2].toLowerCase().slice(0, 3);
    const year = parseInt(monMatch[3], 10);
    const month = MONTH_MAP[monName];
    if (month) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

console.log('23 August 2026 ->', parseDate('23 August 2026'));
console.log('30 August 2026 ->', parseDate('30 August 2026'));
console.log('06 September 2026 ->', parseDate('06 September 2026'));
console.log('13 September 2026 ->', parseDate('13 September 2026'));

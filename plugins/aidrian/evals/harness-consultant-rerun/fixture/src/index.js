// Pantry items, and the ones that run out within a number of days.
export function runningOut(items, days, today = new Date()) {
  const limit = today.getTime() + days * 24 * 60 * 60 * 1000;
  return items.filter((item) => new Date(item.expires).getTime() <= limit).map((item) => item.name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const items = [
    { name: 'milk', expires: '2026-01-03' },
    { name: 'rice', expires: '2027-06-01' },
  ];
  console.log(runningOut(items, 7, new Date('2026-01-01')));
}

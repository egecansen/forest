// Tiny Roman-numeral converter for our 8-phase pipeline. Capped at XX so
// callers don't have to worry about validation — anything past phase 8 is
// out of scope here.
const ROMANS = [
  '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
  'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
];

export function romanize(n: number): string {
  if (n < 0 || n >= ROMANS.length) return String(n);
  return ROMANS[n];
}

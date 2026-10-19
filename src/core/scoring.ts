export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type GSB = 'G' | 'S' | 'B';
const values: Record<Severity, number> = { P0: 1, P1: 2, P2: 3, P3: 4 };

export function dimensionScore(severities: Severity[], submitted: boolean): number | null {
  if (!submitted) return null;
  return severities.length ? Math.min(...severities.map(s => values[s])) : 5;
}

export function gsbNetWin(results: GSB[]): number | null {
  if (!results.length) return null;
  return results.reduce((sum, r) => sum + (r === 'G' ? 1 : r === 'B' ? -1 : 0), 0) / results.length;
}

export function requiresFullReview(disagreements: number, completed: number, planned = 10): boolean {
  return completed === planned && disagreements / planned > 0.3;
}

/**
 * Checks if all characters of `query` appear in order (non-contiguous)
 * within `text`. Case-insensitive. Empty query matches everything.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  if (query.length === 0) return true;
  const lower = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < lower.length && qi < query.length; ti++) {
    if (lower[ti] === query[qi]) {
      qi++;
    }
  }
  return qi === query.length;
}

/**
 * Scores how well `query` matches `text`.
 * - 0 = no match
 * - Higher = better match
 * - Direct substring match scores higher than scattered fuzzy match
 * - Consecutive character runs score higher than dispersed matches
 * - Case-insensitive
 * - Empty query returns 0 (caller should short-circuit)
 */
export function fuzzyScore(query: string, text: string): number {
  if (query.length === 0) return 0;
  const lowerQ = query.toLowerCase();
  const lowerT = text.toLowerCase();

  // Bonus for direct substring match
  const idx = lowerT.indexOf(lowerQ);
  if (idx !== -1) {
    // Earlier match + exact substring = very high score
    // Base 1000 + bonus for early position
    return 1000 + Math.max(0, 50 - idx) + lowerQ.length * 10;
  }

  // Fuzzy non-contiguous match scoring
  let score = 0;
  let qi = 0;
  let prevTi = -1;
  let consecutiveBonus = 0;

  for (let ti = 0; ti < lowerT.length && qi < lowerQ.length; ti++) {
    if (lowerT[ti] === lowerQ[qi]) {
      // Base points per matched char
      score += 100;

      // Consecutive match bonus
      if (prevTi >= 0 && ti === prevTi + 1) {
        consecutiveBonus += 50;
      }

      // Earlier matches are better
      score += Math.max(0, 50 - ti);

      prevTi = ti;
      qi++;
    }
  }

  // Not all chars matched
  if (qi < lowerQ.length) return 0;

  return score + consecutiveBonus;
}

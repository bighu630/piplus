export interface DiffLine {
  type: 'add' | 'delete' | 'same';
  text: string;
}

/**
 * Compute a simple line-by-line diff between oldText and newText.
 * Uses a longest-common-subsequence (LCS) approach on lines.
 * Returns an array of DiffLine entries preserving order.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');

  // Fast path: identical
  if (oldText === newText) {
    return newLines.map((line) => ({ type: 'same' as const, text: line }));
  }

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Walk back through the table to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  // Temporary stacks for reverse-order collection
  const addStack: string[] = [];
  const deleteStack: string[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // Flush pending add/delete stacks
      while (addStack.length > 0) result.push({ type: 'add', text: addStack.pop()! });
      while (deleteStack.length > 0) result.push({ type: 'delete', text: deleteStack.pop()! });
      result.push({ type: 'same', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      addStack.push(newLines[j - 1]);
      j--;
    } else if (i > 0) {
      deleteStack.push(oldLines[i - 1]);
      i--;
    }
  }

  // Flush remaining
  while (addStack.length > 0) result.push({ type: 'add', text: addStack.pop()! });
  while (deleteStack.length > 0) result.push({ type: 'delete', text: deleteStack.pop()! });

  // The walk-back produces lines in reverse order; reverse once
  result.reverse();

  return result;
}

/**
 * Compute a diff where the entire oldText is replaced by newText.
 * Specialized for `write` tool: shows everything as additions.
 */
export function computeWriteDiff(newText: string): DiffLine[] {
  if (!newText) return [];
  const lines = newText.split('\n');
  return lines.map((line) => ({ type: 'add' as const, text: line }));
}

/**
 * Truncate a long diff to a maximum number of lines, showing a summary.
 * Returns { lines, truncated }.
 */
export function truncateDiff(
  lines: DiffLine[],
  maxLines: number,
): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= maxLines) return { lines, truncated: false };

  const headCount = Math.floor(maxLines * 0.6);
  const tailCount = maxLines - headCount - 1; // 1 line for the "…" placeholder

  const head = lines.slice(0, headCount);
  const tail = lines.slice(lines.length - tailCount);

  return {
    lines: [
      ...head,
      { type: 'same' as const, text: `… ${lines.length - headCount - tailCount} more lines …` },
      ...tail,
    ],
    truncated: true,
  };
}

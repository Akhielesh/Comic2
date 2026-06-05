// Minimal line diff (LCS) for the Code Studio "Changes" view (Sprint 3). Pure + testable.

export type DiffOpType = 'ctx' | 'add' | 'del';
export interface DiffOp {
  type: DiffOpType;
  text: string;
}

/** Line-level diff of `oldText` → `newText` via the classic LCS backtrack. */
export const diffLines = (oldText: string, newText: string): DiffOp[] => {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
};

/** Quick added/removed line counts (for a summary badge). */
export const diffStat = (ops: DiffOp[]): { added: number; removed: number } => ({
  added: ops.filter((o) => o.type === 'add').length,
  removed: ops.filter((o) => o.type === 'del').length,
});

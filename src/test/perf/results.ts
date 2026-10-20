import budgetsJson from "./budgets.json";

/** Ceilings in budgets.json, per group; generous so slow CI runners pass. */
export const budgets: Record<string, Record<string, number>> = budgetsJson;

export interface Row {
  group: string;
  metric: string;
  values: number[];
  budgetKey: string;
}

const rows: Row[] = [];

export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** Records a row for the combined table; returns its p95. */
export function record(row: Row): number {
  rows.push(row);
  return percentile(row.values, 95);
}

export function budgetFor(row: Pick<Row, "group" | "budgetKey">): number {
  const [, size] = row.group.split(" ");
  return budgets[size ?? row.group]?.[row.budgetKey] ?? Infinity;
}

// Root-level hook: one table after every perf suite has run.
suiteTeardown(() => {
  if (rows.length === 0) {
    return;
  }
  const head = ["", "metric", "n", "p50 ms", "p95 ms", "budget p95"];
  const body = rows.map((r) => [
    r.group,
    r.metric,
    String(r.values.length),
    percentile(r.values, 50).toFixed(3),
    percentile(r.values, 95).toFixed(3),
    String(budgetFor(r)),
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((b) => b[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i < 2 ? c.padEnd : c.padStart).call(c, widths[i]))
      .join("  ");
  console.log(
    ["", "Performance", line(head), ...body.map(line), ""].join("\n"),
  );
});

/*
 * The console's load budgets, shared by the byte-budget test in the default
 * suite (load-budgets.test.ts, in-process against a seed-realistic.ts DB) and
 * the browser perf check (console-perf.ts, against a scratch collector seeded
 * the same way). A payload over its budget, or a Persona view slower than its
 * budget, fails both.
 *
 * Each byte budget is what the payload measured at DEFAULT_VOLUMES plus about
 * 25%, rounded up. A change that grows one past its budget either trims it
 * back or raises the budget here, on purpose.
 */
import { BOARD_WAITING_PATH } from "../src/lib/board";

/** The hello-ok frame: the WS snapshot every console boots from (1,535,633 bytes measured). */
export const HELLO_OK_BUDGET_BYTES = 1_920_000;

/** The `GET /api/launches` body (149,027 bytes measured). */
export const LAUNCHES_BUDGET_BYTES = 187_000;

/** The first board read a console opened on Persona sends (83,982 bytes measured). */
export const BOARD_FIRST_PAGE_BUDGET_BYTES = 105_000;

/** The board read the console sends first when it opens on any view but the Board. */
export const BOARD_FIRST_PAGE_PATH = BOARD_WAITING_PATH;

/**
 * The worst, over cold loads with no kept view, of the moment the Persona
 * view is usable: the later of the composer enabled and the newest message
 * rendered. A load where either never happens fails it.
 */
export const PERSONA_USABLE_BUDGET_MS = 500;

export interface BudgetCheck {
  metric: string;
  value: number;
  budget: number;
  unit: "bytes" | "ms";
}

/** One line per check: `PASS <metric>: <value> <= <budget>` or `FAIL <metric>: <value> > <budget>`. */
export function budgetLine(check: BudgetCheck): string {
  const ok = check.value <= check.budget;
  return `${ok ? "PASS" : "FAIL"} ${check.metric}: ${check.value} ${check.unit} ${ok ? "<=" : ">"} ${check.budget} ${check.unit}`;
}

export const overBudget = (check: BudgetCheck): boolean => check.value > check.budget;

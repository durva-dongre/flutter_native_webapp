/**
 * constants/unitStatus.ts — Frappe's Unit Progress doctype, field `unit_status`
 * (Select, default "Not Started"): "Not Started\nIn Progress\nCompleted\nStopped".
 * Distinct from a Submission row's own `status` field (Pending/Processing/Completed/
 * Failed — see storage/resign.ts).
 */

export type UnitStatus = "Not Started" | "In Progress" | "Completed" | "Stopped";

export const UNIT_STATUS_OPTIONS: readonly UnitStatus[] = [
  "Not Started",
  "In Progress",
  "Completed",
  "Stopped",
] as const;

export const UNIT_STATUS_DEFAULT: UnitStatus = "Not Started";
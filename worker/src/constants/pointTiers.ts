/**
 * constants/pointTiers.ts — edit thresholds here. Every caller (login, select_profile,
 * sync, last_submission, submit_video, submit_quiz) reads through tierInfo(), so a
 * threshold change here applies immediately — tier is always derived from current
 * points, never stored. Only points_tier is ever returned — no next_tier/points_to_next
 * anywhere in the API surface (Contract §3 rule table).
 */

export interface PointTier {
  id: string;
  min: number;
}

export const DEFAULT_POINT_TIERS: PointTier[] = [
  { id: "bronze", min: 0 },
  { id: "silver", min: 100 },
  { id: "gold", min: 200 },
  { id: "platinum", min: 300 },
];

export interface TierInfo {
  points_tier: string;
}

export function tierInfo(points: number, tiers: PointTier[] = DEFAULT_POINT_TIERS): TierInfo {
  let current = tiers[0] as PointTier;
  for (const t of tiers) {
    if (points >= t.min) {
      current = t;
    } else {
      break;
    }
  }
  return { points_tier: current.id };
}
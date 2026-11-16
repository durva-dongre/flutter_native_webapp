/**
 * config/index.ts — resolves effective config. D1 is read at most once per isolate per
 * CONFIG_REFRESH_SECONDS, refreshed in the background via ctx.waitUntil so no request
 * ever blocks on it. Handlers call config(env, env, ctx) — never read env vars directly.
 */

import { DEFAULT_CONFIG, RUNTIME_OVERRIDABLE_KEYS, GALLERY_SCOPE_FIELDS, type ConfigSchema, type GalleryCascadeStep } from "./defaults";

export interface ConfigEnv {
  DB: D1Database;
}

let cachedOverrides: Partial<ConfigSchema> = {};
let cachedAt = 0;
let refreshInFlight: Promise<void> | null = null;

function coerce<K extends keyof ConfigSchema>(key: K, raw: string, fallback: ConfigSchema[K]): ConfigSchema[K] {
  try {
    if (typeof fallback === "number") {
      const n = Number(raw);
      return (Number.isFinite(n) ? n : fallback) as ConfigSchema[K];
    }
    if (typeof fallback === "boolean") {
      return (raw === "true" || raw === "1") as unknown as ConfigSchema[K];
    }
    if (Array.isArray(fallback)) {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : fallback) as unknown as ConfigSchema[K];
    }
    return raw as unknown as ConfigSchema[K];
  } catch {
    console.error(`[config] invalid override for ${String(key)}, keeping previous layer`);
    return fallback;
  }
}

async function refreshFromD1(env: ConfigEnv): Promise<void> {
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM app_config").all<{ key: string; value: string }>();
    const next: Partial<ConfigSchema> = {};
    for (const row of results ?? []) {
      const k = row.key as keyof ConfigSchema;
      if (!RUNTIME_OVERRIDABLE_KEYS.has(k)) continue;
      next[k] = coerce(k, row.value, DEFAULT_CONFIG[k]) as never;
    }
    cachedOverrides = next;
    cachedAt = Date.now();
  } catch (err) {
    console.error("[config] D1 refresh failed, keeping previous overrides", err);
    cachedAt = Date.now();
  }
}

export function config(
  env: ConfigEnv,
  varsOverride: Partial<Record<string, string>> = {},
  ctx?: ExecutionContext
): ConfigSchema {
  const refreshSeconds = DEFAULT_CONFIG.CONFIG_REFRESH_SECONDS;
  const stale = Date.now() - cachedAt > refreshSeconds * 1000;

  if (stale && !refreshInFlight) {
    refreshInFlight = refreshFromD1(env).finally(() => {
      refreshInFlight = null;
    });
    if (ctx) ctx.waitUntil(refreshInFlight);
  }

  const varsLayer: Partial<ConfigSchema> = {};
  for (const [key, raw] of Object.entries(varsOverride)) {
    if (raw === undefined) continue;
    const k = key as keyof ConfigSchema;
    if (!(k in DEFAULT_CONFIG)) continue;
    varsLayer[k] = coerce(k, raw as string, DEFAULT_CONFIG[k]) as never;
  }

  return { ...DEFAULT_CONFIG, ...varsLayer, ...cachedOverrides };
}

function isValidCascadeStep(step: unknown): step is GalleryCascadeStep {
  if (!step || typeof step !== "object") return false;
  const s = step as Record<string, unknown>;
  return (
    typeof s.field === "string" &&
    (GALLERY_SCOPE_FIELDS as readonly string[]).includes(s.field) &&
    (s.gradeMode === "exact" || s.gradeMode === "any")
  );
}

export function assertConfigValid(cfg: ConfigSchema): void {
  if (cfg.GALLERY_PAGE_DEFAULT > cfg.GALLERY_PAGE_MAX) {
    throw new Error("GALLERY_PAGE_DEFAULT must be <= GALLERY_PAGE_MAX");
  }
  if (cfg.ID_RANDOM_CHARS < 6) {
    throw new Error("ID_RANDOM_CHARS too short to be collision-safe");
  }
  if (cfg.DEFAULT_SUBMISSION_CONTEXT !== "program" && cfg.DEFAULT_SUBMISSION_CONTEXT !== "event") {
    throw new Error("DEFAULT_SUBMISSION_CONTEXT must be 'program' or 'event'");
  }
  if (cfg.GALLERY_SORT !== "recent" && cfg.GALLERY_SORT !== "updated") {
    throw new Error("GALLERY_SORT must be 'recent' or 'updated'");
  }
  if (cfg.GALLERY_ROW_CACHE_SECONDS > cfg.PRESIGN_EXPIRY_SECONDS) {
    throw new Error("GALLERY_ROW_CACHE_SECONDS must be <= PRESIGN_EXPIRY_SECONDS");
  }
  if (cfg.GALLERY_PAGE_CACHE_SECONDS > cfg.PRESIGN_EXPIRY_SECONDS) {
    throw new Error("GALLERY_PAGE_CACHE_SECONDS must be <= PRESIGN_EXPIRY_SECONDS");
  }
  if (cfg.GALLERY_LEVEL_EMPTY_CACHE_SECONDS > cfg.GALLERY_PAGE_CACHE_SECONDS) {
    throw new Error(
      "GALLERY_LEVEL_EMPTY_CACHE_SECONDS must be <= GALLERY_PAGE_CACHE_SECONDS — an empty-level marker must " +
        "expire no slower than a full page cache entry, or newly-promoted rows could be hidden longer than a " +
        "stale page would be."
    );
  }
  if (cfg.GALLERY_FALLBACK_CASCADE.length === 0) {
    throw new Error("GALLERY_FALLBACK_CASCADE must contain at least one step");
  }
  if (!cfg.GALLERY_FALLBACK_CASCADE.every(isValidCascadeStep)) {
    throw new Error(
      "GALLERY_FALLBACK_CASCADE entries must each be {field: one of " +
        GALLERY_SCOPE_FIELDS.join("|") +
        ", gradeMode: 'exact'|'any'}"
    );
  }
  if (cfg.STUDENT_TOKEN_TTL_SECONDS <= 0 || cfg.PHONE_TOKEN_TTL_SECONDS <= 0) {
    throw new Error("STUDENT_TOKEN_TTL_SECONDS and PHONE_TOKEN_TTL_SECONDS must be positive");
  }
}
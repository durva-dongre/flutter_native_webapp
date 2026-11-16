/**
 * handlers/internalHandlers.ts
 * indexBatch validates each row independently (validateRowSafe) — a bad
 * row is skipped and reported in rejected_rows, good rows in the same call
 * still index; null/missing values are explicitly checked before any
 * regex .test() (never coerced to the literal string "null").
 *
 * FIX (cache-generation bump timing): bumpGalleryCacheGeneration used to
 * be called from knownIds — once per pagination page the nightly sweep's
 * set-difference walk requests, i.e. potentially many times per sweep,
 * ALL before any new row exists for the night. It has been moved to fire
 * from indexBatch instead (once per write call, only when rows were
 * actually written), and removed entirely from knownIds, which is now a
 * pure read with no side effect. This stops the gallery page cache from
 * being invalidated N times mid-sweep for every active student, before
 * the night's new rows are even in D1.
 *
 * FIX (pattern consistency): GALLERY_ASSIGNMENT_ID_PATTERN now matches
 * storage/keys.ts::FIELD_PATTERNS.assignment_id exactly ({3,80}, not
 * {1,120}) so this internal validator and the public gallery query
 * validator can never silently disagree on what a valid assignment_id is.
 */

import type { Env } from "../env";
import { invalidInput, unauthorized } from "../env";
import { ok } from "../util/errors";
import { config } from "../config/index";
import {
  upsertGalleryItems,
  setGalleryItemVisibility,
  fetchKnownSubmissionIds,
  normalizeScopeValue,
  type PromoteRow,
} from "../db/gallery";
import { invalidateCachedGalleryRow } from "../cache/galleryRowCache";
import { clearLevelEmpty } from "../cache/galleryLevelCache";

const OBJECT_KEY_PATTERN = /^tapapp\/[A-Za-z0-9_-]{3,80}\/[A-Za-z0-9_-]{3,80}\/[A-Za-z0-9_-]+-[1-9][0-9]?\.[A-Za-z0-9]{1,10}$/;
// FIX: was {1,120}, now matches storage/keys.ts::FIELD_PATTERNS.assignment_id exactly.
const GALLERY_ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9_ -]{3,80}$/;
const GALLERY_STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const GALLERY_SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const GALLERY_SCOPE_ID_PATTERN = /^[A-Za-z0-9_ -]{1,120}$/;

const GALLERY_CACHE_GENERATION_KEY = "gallery_cache_generation";

async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  return diff === 0;
}

async function requireInternalSecret(req: Request, env: Env): Promise<void> {
  const header = req.headers.get("X-Internal-Secret") ?? "";
  const expected = env.INTERNAL_API_SECRET ?? "";
  if (!expected || !(await constantTimeEquals(header, expected))) {
    throw unauthorized("invalid internal secret");
  }
}

async function bumpGalleryCacheGeneration(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?1, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
    )
    .bind(GALLERY_CACHE_GENERATION_KEY)
    .run();
}

async function clearLevelEmptyForRow(row: PromoteRow): Promise<void> {
  const combos: Array<{ field: "assignment_id" | "state" | "district" | "school"; value: string }> = [
    { field: "assignment_id", value: row.assignmentId },
    { field: "state", value: row.state },
    { field: "district", value: row.district },
    { field: "school", value: row.school },
  ];

  await Promise.all(
    combos.flatMap(({ field, value }) =>
      value
        ? [
            clearLevelEmpty({ field, gradeMode: "exact", value, grade: row.grade }),
            clearLevelEmpty({ field, gradeMode: "any", value }),
          ]
        : []
    )
  );
}

interface IndexBatchRowInput {
  academic_year?: unknown;
  assignment_id?: unknown;
  student_id?: unknown;
  submission_id?: unknown;
  first_name?: unknown;
  state?: unknown;
  district?: unknown;
  school?: unknown;
  grade?: unknown;
  media_type?: unknown;
  object_key?: unknown;
  score?: unknown;
  promoted_at?: unknown;
}

interface IndexBatchBody { rows?: IndexBatchRowInput[]; }

interface ValidationOutcome {
  ok: boolean;
  row?: PromoteRow;
  reason?: string;
  submissionId?: string;
}

function validateRowSafe(r: IndexBatchRowInput): ValidationOutcome {
  const submissionId = typeof r.submission_id === "string" ? r.submission_id : undefined;

  if (!r.assignment_id || typeof r.assignment_id !== "string" || !GALLERY_ASSIGNMENT_ID_PATTERN.test(r.assignment_id)) {
    return { ok: false, reason: "assignment_id missing or invalid", submissionId };
  }
  if (!r.student_id || typeof r.student_id !== "string" || !GALLERY_STUDENT_ID_PATTERN.test(r.student_id)) {
    return { ok: false, reason: "student_id missing or invalid", submissionId };
  }
  if (!submissionId || !GALLERY_SUBMISSION_ID_PATTERN.test(submissionId)) {
    return { ok: false, reason: "submission_id missing or invalid", submissionId };
  }
  if (!r.object_key || typeof r.object_key !== "string" || !OBJECT_KEY_PATTERN.test(r.object_key)) {
    return { ok: false, reason: "object_key missing or malformed", submissionId };
  }
  if (typeof r.academic_year !== "number" || !Number.isInteger(r.academic_year) || r.academic_year < 2000 || r.academic_year > 2100) {
    return { ok: false, reason: "academic_year missing or invalid", submissionId };
  }
  if (typeof r.grade !== "number" || !Number.isInteger(r.grade) || r.grade < 1 || r.grade > 99) {
    return { ok: false, reason: "grade missing or invalid", submissionId };
  }
  if (!r.state || !r.district || !r.school || typeof r.state !== "string" || typeof r.district !== "string" || typeof r.school !== "string") {
    return { ok: false, reason: "state/district/school missing", submissionId };
  }
  if (![r.state, r.district, r.school].every((v) => GALLERY_SCOPE_ID_PATTERN.test(v as string))) {
    return { ok: false, reason: "state/district/school invalid", submissionId };
  }
  if (typeof r.promoted_at !== "number" || !Number.isInteger(r.promoted_at) || r.promoted_at <= 0) {
    return { ok: false, reason: "promoted_at missing or invalid", submissionId };
  }
  const mediaType = r.media_type === "video" ? "video" : r.media_type === "image" || r.media_type === undefined ? "image" : null;
  if (mediaType === null) {
    return { ok: false, reason: "media_type invalid", submissionId };
  }

  return {
    ok: true,
    row: {
      academicYear: r.academic_year,
      assignmentId: r.assignment_id,
      studentId: r.student_id,
      submissionId,
      firstName: typeof r.first_name === "string" ? r.first_name : undefined,
      state: normalizeScopeValue(r.state),
      district: normalizeScopeValue(r.district),
      school: normalizeScopeValue(r.school),
      grade: r.grade,
      mediaType,
      objectKey: r.object_key,
      score: typeof r.score === "number" ? r.score : undefined,
      promotedAt: r.promoted_at,
    },
  };
}

async function indexBatch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await requireInternalSecret(req, env);
  const cfg = config(env, env as unknown as Record<string, string>);

  const body = (await req.json().catch(() => ({}))) as IndexBatchBody;
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw invalidInput("rows missing or empty");
  }
  if (body.rows.length > cfg.INDEX_BATCH_MAX) {
    throw invalidInput(`too many rows in one batch (max ${cfg.INDEX_BATCH_MAX})`);
  }

  const valid: PromoteRow[] = [];
  const rejected: Array<{ submission_id?: string; reason: string }> = [];

  for (const r of body.rows) {
    const outcome = validateRowSafe(r);
    if (outcome.ok && outcome.row) {
      valid.push(outcome.row);
    } else {
      rejected.push({ submission_id: outcome.submissionId, reason: outcome.reason ?? "unknown" });
      console.error(`[internal/gallery/index] rejected row: ${outcome.reason}`, { submission_id: outcome.submissionId });
    }
  }

  if (valid.length > 0) {
    await upsertGalleryItems(env.DB, valid);
    // FIX: generation bump now lives here — once per write call, only when
    // rows were actually written — instead of in knownIds (see module docblock).
    ctx.waitUntil(
      Promise.all([
        ...valid.map((r) => invalidateCachedGalleryRow(r.submissionId)),
        ...valid.map((r) => clearLevelEmptyForRow(r)),
        bumpGalleryCacheGeneration(env.DB),
      ]).then(() => undefined)
    );
  }

  return ok({ indexed: valid.length, rejected: rejected.length, rejected_rows: rejected });
}

interface VisibilityBody { submission_id?: string; visible?: boolean; }

async function visibility(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await requireInternalSecret(req, env);

  const body = (await req.json().catch(() => ({}))) as VisibilityBody;
  if (!body.submission_id) throw invalidInput("submission_id missing");
  if (typeof body.visible !== "boolean") throw invalidInput("visible missing or not boolean");

  await setGalleryItemVisibility(env.DB, body.submission_id, body.visible);

  ctx.waitUntil(invalidateCachedGalleryRow(body.submission_id));

  if (body.visible) {
    ctx.waitUntil(
      (async () => {
        const row = await env.DB.prepare(
          `SELECT assignment_id, state, district, school, grade FROM gallery_items WHERE submission_id = ?1`
        )
          .bind(body.submission_id)
          .first<{ assignment_id: string; state: string; district: string; school: string; grade: number }>();
        if (!row) return;
        await clearLevelEmptyForRow({
          academicYear: 0,
          assignmentId: row.assignment_id,
          studentId: "",
          submissionId: body.submission_id as string,
          state: row.state,
          district: row.district,
          school: row.school,
          grade: row.grade,
          mediaType: "image",
          objectKey: "",
          promotedAt: 0,
        });
      })()
    );
  }

  return ok({ submission_id: body.submission_id, visible: body.visible });
}

interface KnownIdsBody { since?: number; cursor?: number | null; limit?: number; }

const KNOWN_IDS_DEFAULT_LIMIT = 500;

async function knownIds(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  await requireInternalSecret(req, env);

  const body = (await req.json().catch(() => ({}))) as KnownIdsBody;
  if (typeof body.since !== "number" || !Number.isFinite(body.since) || body.since < 0) {
    throw invalidInput("since missing or invalid");
  }
  let cursor: number | null = null;
  if (body.cursor !== undefined && body.cursor !== null) {
    if (!Number.isInteger(body.cursor) || body.cursor < 0) throw invalidInput("cursor invalid");
    cursor = body.cursor;
  }
  let limit = KNOWN_IDS_DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1) throw invalidInput("limit invalid");
    limit = body.limit;
  }

  // FIX: no cache-generation bump here anymore — this is a pure read used
  // during the sweep's pagination; the bump now happens once in indexBatch,
  // only when rows are actually written (see module docblock).
  const page = await fetchKnownSubmissionIds(env.DB, body.since, cursor, limit);

  return ok({ submission_ids: page.ids, next_cursor: page.nextCursor });
}

export const internalHandlers = { indexBatch, visibility, knownIds };
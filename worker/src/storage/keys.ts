/**
 * storage/keys.ts — Contract §6.1: tapapp/{assignment_id}/{student_id}/{submission_id}-
 * {attempt}.{ext}. No academic_year, no state/district/school/grade, no context
 * anywhere in the path.
 *
 * ACCEPTED_FORMATS_FOR mirrors tap_lms/shared/submission/object_naming.py's
 * EXT_TO_SUBMISSION_TYPE / CONTENT_TYPE_TO_SUBMISSION_TYPE tables exactly — any
 * extension accepted on one side must be accepted on the other, or a submission minted
 * in one format silently fails to resolve its media type during R2 promotion.
 */

import { invalidInput } from "../env";

export type SubmissionType = "image" | "video";

export const EXT_FOR: Record<SubmissionType, string> = {
  image: "webp",
  video: "mp4",
};

export const CONTENT_TYPE_FOR: Record<SubmissionType, string> = {
  image: "image/webp",
  video: "video/mp4",
};

export interface AcceptedFormat {
  ext: string;
  contentType: string;
}

export const ACCEPTED_FORMATS_FOR: Record<SubmissionType, Readonly<Record<string, AcceptedFormat>>> = {
  image: {
    webp: { ext: "webp", contentType: "image/webp" },
    jpg: { ext: "jpg", contentType: "image/jpeg" },
    jpeg: { ext: "jpeg", contentType: "image/jpeg" },
    png: { ext: "png", contentType: "image/png" },
    heic: { ext: "heic", contentType: "image/heic" },
  },
  video: {
    mp4: { ext: "mp4", contentType: "video/mp4" },
    mov: { ext: "mov", contentType: "video/quicktime" },
    webm: { ext: "webm", contentType: "video/webm" },
    "3gp": { ext: "3gp", contentType: "video/3gpp" },
  },
};

export function resolveAcceptedFormat(submissionType: SubmissionType, formatHint: unknown): AcceptedFormat {
  if (formatHint === undefined || formatHint === null || formatHint === "") {
    return { ext: EXT_FOR[submissionType], contentType: CONTENT_TYPE_FOR[submissionType] };
  }
  if (typeof formatHint !== "string") {
    throw invalidInput("format must be a string");
  }
  const key = formatHint.trim().toLowerCase().replace(/^\./, "");
  const table = ACCEPTED_FORMATS_FOR[submissionType];
  const match = table[key];
  if (!match) {
    throw invalidInput(
      `format "${formatHint}" is not accepted for submission_type "${submissionType}" (accepted: ${Object.keys(table).join(", ")})`
    );
  }
  return match;
}

export function findAcceptedFormatByExt(submissionType: SubmissionType, ext: string): AcceptedFormat | null {
  const table = ACCEPTED_FORMATS_FOR[submissionType];
  const key = ext.trim().toLowerCase();
  return table[key] ?? null;
}

export const AUDIO_EXT = "mp3";
export const AUDIO_CONTENT_TYPE = "audio/mpeg";

export const FIELD_PATTERNS = {
  assignment_id: /^[A-Za-z0-9_ -]{3,80}$/,
  student_id: /^[A-Za-z0-9_-]{3,80}$/,
  submission_id: /^[a-z2-7]{6,16}$/,
  attempt: /^[1-9][0-9]?$/,
} as const;

export interface KeyFields {
  assignmentId: string;
  studentId: string;
  submissionId: string;
  attempt: number;
  ext: string;
}

export function buildObjectKey(fields: KeyFields): string {
  return `tapapp/${fields.assignmentId}/${fields.studentId}/${fields.submissionId}-${fields.attempt}.${fields.ext}`;
}

export function mintSubmissionId(randomChars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(randomChars));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (let i = 0; i < randomChars; i++) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

export interface ParsedObjectKey {
  assignmentId: string;
  studentId: string;
  submissionId: string;
  attempt: number;
  ext: string;
}

export function parseObjectKey(objectKey: string): ParsedObjectKey {
  const keyParts = objectKey.split("/");
  if (keyParts.length !== 4 || keyParts[0] !== "tapapp") {
    throw invalidInput("object_key does not match the expected shape");
  }
  const [, assignmentId, studentId, filename] = keyParts as [string, string, string, string];
  const fileMatch = /^([a-z2-7]{6,16})-([1-9][0-9]?)\.([a-zA-Z0-9]{1,10})$/.exec(filename);
  if (!fileMatch) throw invalidInput("object_key filename does not match the expected shape");
  const [, submissionId, attemptStr, extRaw] = fileMatch as unknown as [string, string, string, string];

  return { assignmentId, studentId, submissionId, attempt: Number(attemptStr), ext: extRaw.toLowerCase() };
}

export function assertObjectKeyMatches(candidate: string, expectedFields: KeyFields): void {
  if (!FIELD_PATTERNS.assignment_id.test(expectedFields.assignmentId)) throw invalidInput("assignment_id is malformed");
  if (!FIELD_PATTERNS.student_id.test(expectedFields.studentId)) throw invalidInput("student_id is malformed");
  if (!FIELD_PATTERNS.submission_id.test(expectedFields.submissionId)) throw invalidInput("submission_id is malformed");
  if (!FIELD_PATTERNS.attempt.test(String(expectedFields.attempt))) throw invalidInput("attempt is malformed");

  const expected = buildObjectKey(expectedFields);
  if (candidate !== expected) {
    throw invalidInput("object_key does not match the key request_upload issued");
  }
}
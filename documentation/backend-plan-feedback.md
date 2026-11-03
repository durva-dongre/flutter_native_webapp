# Feedback on the TapApp backend plan

**For:** "TAP APP New Things" (plan dated 2026-11-01).
**Date:** 2026-11-02

## How to read this

This note compares the plan with our **latest requirements**.

**The requirements document (`v1-requirements.md`) always wins.** It was reviewed with the stakeholders. If this plan and the requirements say different things, we follow the requirements. Please also read `system-understanding.md`. It describes how the current TAP backend works, checked in the code on branch `journey_2026`.

**What v1 is.** v1 is a **test release in mid-November** for a very small group of kids (30 to 100). They are already registered. Each kid gets a magic link. The flow is simple and fixed: greeting, video, submission, then quiz. We keep v1 small. Many items in the plan are good ideas for later, not for v1.

The `tapapp` code will be added to the `frappe_tap` branch `journey_2026`, as a module in the same app (R-46).

---

## 1. Please change these (the plan conflicts with a decision)

| # | The plan says | What we need instead |
|---|---|---|
| 1 | **Remove Student Enrollment** and put it into Program Enrollment. | Do not remove it. The live WhatsApp content calls read the Student Enrollment rows (batch and date of joining) to find the student's active batch. Removing it breaks WhatsApp. We do not change existing production behavior without approval. |
| 2 | **`Student.phone` is unique.** | Do not add this rule. Brothers and sisters share one phone, and each is a separate Student (R-34). Your own login (step 5b, "more than one match") also needs several students on one phone. The data also has both 10-digit and 12-digit phones. |
| 3 | A **new submission flow**: Frappe signs an upload URL, the file goes to GCP, a queue worker checks it, then `finalize`, then a handoff to an "external review system". | Use the existing call `submit_artwork(assignment_id, student_id, submission)` as it is (R-27, R-89). The "external review system" already exists: `tap_plg`, `rag_service` and the feedback consumer. You do not need handoff code or a result webhook. |
| 4 | **New Submission statuses**: Uploading, Pending Review, In Review, Approved, Rejected, Expired. | Keep the existing statuses (Pending, Processing, Completed, Failed). Valid or not valid comes from the field `submission_validity` (Valid or Invalid) (R-76). |
| 5 | **Overwrite `submission_url`** with the R2 URL after approval. | Do not overwrite it. The student's own work stays in GCS. Only the Gallery gets a copy in R2, made after the feedback says the work is valid (R-88). The existing pipeline also uses `submission_url`. |
| 6 | **One retry only**, then the state `attempt_limit_reached`. | After invalid work the student sends corrected work (R-76). The next activity opens only after valid feedback (R-83). If we stop after one retry, a student with a second invalid result is stuck. Do not limit the attempts in v1. |
| 7 | **GCP keys in Shared Settings** inside Frappe, and Frappe makes the signed URLs. | The Cloudflare Worker holds the Google Cloud service account. The Worker gives the app a short upload link and reads the files (R-82, R-88, R-89). Keys must not be stored in the Frappe database. |
| 8 | A magic link that is **single use** (Redis token, deleted at once). | A link must work more than once until it expires. A phone can lose its saved data, and the student must be able to open the same link again (see `whatsapp-link-login.md`, LS1 and LS2). |
| 9 | **Weekly cap, weekly reset, streaks, gems**, and a "Tuesday 4 pm" release. | v1 has **no weekly limit and no deadline** (R-39, R-72). **Streaks are paused** (kids do not understand them). Gems are not in the design. The only pace rule is R-83. |
| 10 | A **Program Enrollment** with new fields and new status values. | `ProgramEnrollment` already exists in `frappe_tap` with other fields (`program_status`, `resolved_flow_state`, `current_week` and more). It is empty today because the old Summer Program engine is switched off. We use it as our progress record (R-48). Please show how your fields fit into the existing table. Do not create a second table with the same name. |

## 2. Please add these (in the requirements, missing in the plan)

1. **The valid-feedback gate (R-83).** `advance_unit` moves forward when a video or quiz is done. Something must keep the next activity closed until the feedback for the submission is valid.
2. **A quiz that runs on the server (R-91).** We need calls to start the quiz and to answer one question. The server sends one question at a time, checks each answer, accepts answer N+1 only after answer N, and stores every answer. The browser never gets the correct answer. In your plan the app sends the answers in one batch.
3. **Safe repeats (R-38, R-40).** If the phone sends the same step twice, points must be given only once. Use an idempotency key for each step (a key that stops the same step from being saved twice), not only for the points queue.
4. **The point rules (R-75).** Video +10, sharing the work +25 (given at once), each correct quiz answer +1, correct submission +10 (given after valid feedback). Your settings have no separate value for the +25.
5. **The full feedback (R-16, R-56).** Feedback has a text, a translated text and an audio file. Your plan has one `feedback` field. The Results screen needs all three.
6. **Valid or not valid (R-92).** A result with grade 0 or the text "technical issue" counts as **not valid**.
7. **Login details** (`whatsapp-link-login.md`):
   - look up the phone in both the 10-digit and 12-digit forms;
   - a link can carry a student (`st:`) and a place to open;
   - the list of children comes from students with an enrollment in an **active batch**;
   - the Worker checks that the student belongs to the phone on every call (R-81).
8. **Content beyond units** (`content-spec.md`): the messages of the standard flow, the audio files, example works, picture pieces. Your export covers only units. Languages for v1 are Hindi and English.
9. **The Gallery rules (R-59, R-85):** only valid work, only pictures and videos, **initials** and not the full name, random order, a small number of items each time.
10. **Deletion (R-96):** photos, videos and the R2 copies are deleted when the student moves to a new batch (once a year).
11. **Tools for the test group:** a way to register kids who are missing, and a script that makes the **magic links for the 30 to 100 kids**. The plan has only a link action inside the ops dashboard, which is "not in focus".

## 3. Good ideas, but not for v1 (please keep them for later)

- **Ask TAP with an AI chat** (Durable Object, LLM, BigQuery). v1 has prepopulated questions only (R-70).
- **Events** (`Event Campaign`, `Student Event Enrollment`, `events.json`). These are for v1.1 (R-86). For v1 we only **leave room** for them (R-94). The banner may also target a batch, a school, a state or a random group, and show information messages. Your event scope does not cover those.
- **The Gallery listing by school, district and state, which widens the search step by step when there is little work.** Choosing which students' work is shown is a later setting (R-85).
- **The ops dashboard, the Redis points queue, the layered rate limits, nightly analytics, BigQuery export and the load-test suite.** For a test with under 100 kids this is too much. The Worker already has rate limits.
- **Outreach stages** (`no_response`, `reengagement_exhausted`, `delivery_failure`) and their nudge jobs. They need Glific messages that v1 does not have.

## 4. Please fix inside the document

- Section 4 uploads to **GCP**, but the API list says **private R2**. The consumer is called both a "GCP event" and an "R2 event" consumer. Pick one.
- **Names differ in places:** Student Event Enrollment statuses (active, completed, missed, versus enrolled, active, completed, missed); the Program Enrollment field is called `points` in one place and `weekly_points` and `total_points` in another; the folder is `tap_app`, `tapapp` and `app_submission`.
- The dashboard's **stage funnel** uses values (`video_watched`, `binge_limit`) that are not in the Program Enrollment stage list.
- **`skills_json` and a "skill-weight map"** are still mentioned, but the field was removed.
- The plan says the **Worker lives in the frappe repo.** Our Worker is in the Flutter repo (`flutter_native_webapp/worker`).

## 5. About the last note in the plan

The note says progress is stored on the Glific side and not in our LMS, so a student could not continue from WhatsApp in the app.

What we know: `frappe_tap` does **not** store the video steps, quiz answers or points of the WhatsApp flow (from the code on `journey_2026`). The WhatsApp flow keeps points, streak and gems in **Glific contact fields** (`total_points`, `activity_points`, `streak`, `special_gems`), as the lead's flow export shows. Our backend and the app cannot read them.

So the worry is right, and it is **decided**: in v1 the app does **not** sync with Glific. The kids' WhatsApp curriculum and the app curriculum are separate. The app keeps its own progress in `ProgramEnrollment` (R-48).

## 6. What we agree with

A magic link by phone with no OTP, a profile list and a phone token for siblings, each step saved at once, no answer key in the content files, content served as static files from R2, and the Gallery served from R2.

## 7. Next step

Please make a **smaller v1 version** of the plan that follows the requirements, and put the rest in a "later" section. The v1 version should cover: login, progress and quiz, the existing `submit_artwork` and feedback, and the Gallery copy. Please send the updated plan for review before you start building.

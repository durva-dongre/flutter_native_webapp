# v1 task breakdown (draft)

**Date:** 2026-11-02 (second version: automated tests are now included for each task)
**Purpose:** a list of the changes needed for the v1 test release, with a rough effort for each. We will use it to plan and to track the work.
**Source:** `v1-requirements.md` (it always wins), `tapapp-changes.md`, `backend-plan-feedback.md` and `build-bootstrap.md`.

## How to read this

- **Effort is in working days for one developer who knows the code.** Each task has a low and a high number. They are rough.
- **Two efforts for each task:** **Build** (write the code) and **Tests** (write the automated tests for it). A task is **done only when its tests pass on a developer's machine, with one command (E4).** There is no CI yet. The "Automated tests" column says what the tests check.
- **What stays manual:** the WhatsApp in-app browser, the phone camera and video playback cannot be automated. They are tested by hand on real phones (E2) with a written checklist.
- **Priority.** **P1**: needed for the mid-November test release. **P2**: in the requirements for v1, but it can follow the first test, or we ask if the test group needs it. Later items (events, a stronger login, tiered rewards and so on) are not listed. See section 2 of the requirements.
- **Depends on** lists tasks that must start first. A to E are the groups below.
- **Assumptions:** `journey_2026` is the deployed branch. The test group is 30 to 100 pre-registered kids. The flow is hardcoded: greeting, video, submission, quiz. Each kid gets a magic link. The three daily feedback windows stay as they are.
- **Dates.** The test release is in mid-November. Today is 2 November, so there are about 10 to 14 working days.

## Totals (days)

| Group | P1 build | P1 tests | P1 total | P2 total | All |
|---|---|---|---|---|---|
| Backend: `tapapp` in `frappe_tap` (branch `journey_2026`) | 16 to 26 | 8.5 to 13 | 24.5 to 39 | 4.5 to 7 | 29 to 46 |
| Worker (`worker/`, in the Flutter repo) | 8.5 to 13.5 | 4 to 7 | 12.5 to 20 | 0 | 12.5 to 20 |
| Flutter app (`lib/`) | 22.5 to 32 | 7 to 11 | 30 to 43 | 4 to 6 | 33.5 to 49 |
| Setup, testing and checks | 7 to 10.5 | 0 to 0.5 | 7 to 11 | 0 | 7 to 11 |
| **All groups** | **54 to 82** | **20 to 31** | **74 to 113** | **8 to 13** | **82 to 126** |

**What this means.** The P1 work, with tests, is about **74 to 113 developer-days**. Tests are about 37 percent of the build effort. With 10 to 14 working days before the test, that needs about **5 to 11 developers working in parallel**, with no slack. If the team is smaller, we have to cut. See "How to cut" below.

## B. Backend: `tapapp` in `frappe_tap` (branch `journey_2026`)

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| B1 | Move the module | Copy only `tapapp/` and its DocTypes. Solve the `Secrets` problem. Do not copy the daily jobs or the `ca` hooks. Make `bench migrate` pass. | A smoke test: the module imports and the DocTypes load after `bench migrate`. | R-46, `tapapp-changes.md` s.6 | 1 to 2 | 0.25 to 0.5 | A1 | P1 |
| B2 | Close the security holes | Remove guest access, the password and OTP code. One Worker credential on every call. Check that the student belongs to the phone. | Each call refuses: no credential, a wrong credential, a student of another phone. A test that fails if any `allow_guest` call is left. | R-33, R-81, `tapapp-changes.md` s.2 | 1.5 to 2.5 | 1 to 1.5 | B1 | P1 |
| B3 | Remove the old model | Drop `Tapapp Learner`, `Tapapp Auth Profile`, streak, gems, archetype, weekly cap, achievements and both jobs. Read children from `Student` by phone (10 and 12 digit forms, active batch). A patch for the removal. | Children by phone: 10 and 12 digit forms, siblings, no active batch, no enrollment. The patch can run twice. | R-34, R-39, R-48, LS4 | 1.5 to 2.5 | 1 to 1.5 | B2 | P1 |
| B4 | Step log and points settings | Fields on `ProgramEnrollment` for steps (video, quiz answers, work sent) with idempotency keys. A small settings doctype for point values. Agree the fields first (a change to a production doctype). | The same key twice writes once. Two writes at the same time. Point settings are read, not fixed in code. | R-38, R-40, R-41, R-48, R-75 | 2 to 3 | 1 to 1.5 | B3, A2 | P1 |
| B5 | Server quiz | Start a quiz, answer one question. One question at a time, answer checked on the server, answer N+1 only after N, every answer stored, no correct answer sent. | Order N+1, the same question twice, every answer stored, **the correct answer is never in any response**, a retake. | R-91 | 2 to 3 | 1 to 1.5 | B4 | P1 |
| B6 | Submission path | Upload link and the call to `submit_artwork` for one upload. A guard against duplicates. Uses the GCS service account. | `submit_artwork` is called once for each upload (mocked). A duplicate is ignored. A bad file type is refused. | R-27, R-89 | 2 to 3 | 1 to 1.5 | B2, E1 | P1 |
| B7 | Valid or not valid, points, gate | Read `submission_validity` (grade 0 or "technical issue" is not valid). Give +10 after valid feedback and +25 for sharing. Keep the next activity closed until feedback is valid. | Valid gives +10. Invalid and grade 0 give 0. +25 at once. Points once for each submission. The gate is closed, then open. | R-75, R-76, R-83, R-92 | 1.5 to 2.5 | 1 to 1.5 | B4, B6 | P1 |
| B8 | Feedback and "My projects" reads | Read the feedback (text, translated text, audio link), the valid flag and the list of projects from `Submission`, the points and the course assignments. | The shape of the answer. A student cannot read another student's feedback. | R-16, R-56, R-87 | 1 to 2 | 0.5 to 1 | B7 | P1 |
| B9 | Placeholder tags and empty banner call | A fixed set of tags for all students (Manu gives the tags). A banner call that returns an empty list. | A schema check of both answers. | R-94, R-95 | 0.5 to 1 | 0.25 | B2 | P1 |
| B10 | Test group tools | Register the kids who are missing. A script that makes the magic links for the 30 to 100 kids. | A link made by the script is accepted by the Worker check, and a changed link is refused. | R-32, `whatsapp-link-login.md` | 1 to 1.5 | 0.5 | B3 | P1 |
| B11 | Content files for the CDN | A script that builds the JSON files (units, flow messages) and a manifest, as in `content-spec.md`. No correct answers in the files. Fix the export (wrong table, missing doctypes and fields). | JSON Schema checks. No answer key in any file. Hashes match the manifest. A missing language fails the build. | R-18, R-91, `content-spec.md` | 2 to 3 | 1 to 1.5 | A3, E1 | P1 |
| B12 | Gallery copy to R2 | After valid feedback, copy the work to a separate place in R2. A list of valid work, initials, random order, 5 to 10 items. | Only valid work is copied. The copy runs twice safely. Initials, not names. The list has 5 to 10 items. | R-59, R-85, R-88 | 2 to 3 | 1 to 1.5 | B7, E1 | P2 |
| B13 | Delete media on batch change | Delete photos, videos and the R2 copies when the student moves to a new batch. Find out who deletes the original GCS files. | Media of the old batch is deleted, other media is not. A dry-run mode. | R-96 | 1 to 1.5 | 0.5 to 1 | B12 | P2 |

**Group total:** build 19 to 30.5 days, tests 10 to 15 days, together 29 to 46 days.

## C. Worker (`worker/`, in the Flutter repo)

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| C1 | Remove the prototype AI | Remove `groq.js`, `tapbuddy.js` and `submission_review.js` and their routes. | The route table has no AI routes. | AP list in `production-readiness.md` | 0.5 | 0.1 to 0.25 | - | P1 |
| C2 | Login | Verify the signed WhatsApp link, issue the phone token and the student token, `select_student`, rate limits. The token comes after `#` in the link. | A link: valid, expired, changed, wrong phone. Token shape. The rate limit. A student of another phone is refused. | R-31 to R-34, `whatsapp-link-login.md` | 2 to 3 | 1 to 1.5 | C1 | P1 |
| C3 | Per-student checks and the Frappe key | The Worker checks that the student belongs to the phone on every call. The Frappe key stays as a Worker secret and the Worker sends the `Authorization` header. | Every route needs a token. The key never appears in a response or a log. The header is sent to Frappe (mocked). | R-81, R-82 | 1 to 1.5 | 0.5 to 1 | C2 | P1 |
| C4 | Routes | Home, steps, quiz start and answer, upload link and submit, feedback, my projects, gallery, banner list. | Contract tests with recorded Frappe answers. Errors are mapped to friendly codes. | `build-bootstrap.md` s.7 | 3 to 5 | 1.5 to 2.5 | C3, B4-B8 | P1 |
| C5 | Google Cloud storage access | Read the private submission bucket (HMAC keys of the service account as Worker secrets), make short upload and read links, and test that photos and videos play. A risk: not tested yet. | Unit tests for the signing. An integration test on a test bucket (runs only when the secrets exist). Playback is tested by hand (E2). | R-88, R-89 | 1.5 to 2.5 | 0.5 to 1 | E1 | P1 |
| C6 | Safe repeats | Idempotency keys on steps and a guard so one upload makes only one `submit_artwork` call. | The same key twice, and two uploads of the same work. | R-38, R-89 | 0.5 to 1 | 0.25 to 0.5 | C4 | P1 |

**Group total:** build 8.5 to 13.5 days, tests 4 to 7 days, together 12.5 to 20 days.

## D. Flutter app (`lib/`)

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| D0 | Clean up the prototype | Remove hard-coded values, the AI calls, "2 units a week", streak and gems. Bundle the fonts. Replace the 7.6 MB loader GIF. Friendly errors with a Retry button. | `flutter analyze` and the architecture check pass locally. A test that finds no AI client and no streak or gem code. | R-39, R-43, R-44, AP1-AP9 | 2 to 3 | 0.25 to 0.5 | - | P1 |
| D1 | App shell | Three tabs (Home, Gallery, Me). "Who is learning". Welcome back. The TAP Buddy picture as the profile picture. The offline screen with Retry. Settings and Edit profile. | Widget tests: the tabs, the name picker, the offline screen and Retry, the route redirects. | R-1 to R-8, R-60, R-71, R-73, R-74 | 3 to 4 | 1 to 1.5 | D0 | P1 |
| D2 | Login screens | Open the magic link, the name picker for a phone with several children, switch profile. | Widget tests: a good link, an expired link, one child goes straight in, several children show the picker. | R-31 to R-34 | 1.5 to 2 | 0.5 to 1 | C2 | P1 |
| D3 | Watch step | Greeting, the video, an "I watched it" button, +10 points. | Widget tests: the states, and the button saves the step only once. | R-61, R-62, R-90 | 1.5 to 2 | 0.5 to 0.75 | D1 | P1 |
| D4 | Quiz step | One question at a time from the server, right or wrong feedback, points, a summary. | Widget tests: the flow, right and wrong, the summary, a retry after a lost connection. | R-67, R-91 | 2 to 3 | 0.75 to 1 | D5, C4 | P1 |
| D5 | Make step | Photo and video capture, resize photos to JPEG, upload with retry, a message when the camera is refused, a 90 second video limit, "send later". | Unit tests: resize to JPEG, the size and length limits, the retry logic. Widget tests: the permission message, the pending state. The camera itself is tested by hand (E2). | R-9, R-11 to R-13, R-63, R-64, R-66 | 3 to 4.5 | 1 to 1.5 | D3, C4 | P1 |
| D6 | Results chat | Feedback messages with speaker icons, the "Yes" button, the "YOU WON" card, the points reveal, the picture badge, not valid and "send again", "Points will be provided after feedback". | Widget or golden tests for each chat state. The points show only after the tap. Not valid shows "send again". | R-68, R-69, R-75, R-76, R-83, F-6 | 3 to 4 | 1 to 1.5 | D4, C4 | P1 |
| D7 | Home | Greeting, points, one activity card with its states, a banner slot (empty in v1). | Widget tests: every card state, an empty banner slot. | R-4, R-94 | 2 to 2.5 | 0.5 to 0.75 | D1 | P1 |
| D8 | Me | Profile, level, points, My projects, placeholder tags. | Widget tests: with and without projects, the level and the tags. | R-7, R-87, R-95 | 2 to 3 | 0.5 to 0.75 | D1, B8 | P1 |
| D9 | Gallery | Valid work, initials, viewer, load more. | Widget tests: an empty Gallery, a full grid, the viewer. | R-6, R-59, R-85 | 2 to 3 | 0.5 to 1 | B12 | P2 |
| D10 | Ask TAP | The panel with prepopulated questions for the step. | A widget test: the questions follow the step. | R-70 | 1 to 1.5 | 0.25 to 0.5 | D1 | P2 |
| D11 | Content loader | Manifest, hashes, caching, first-run copy and download retry. | Unit tests: a changed hash downloads one file, the first-run copy works offline, a failed download retries, a unit already open keeps its old files. | R-18 to R-22, R-79 | 2 to 3 | 1 to 1.5 | B11 | P1 |
| D12 | Build and deploy | `scripts/build_web.sh`, hosting and Worker deploy, secrets. | The local test command builds the web app and runs `wrangler deploy --dry-run`. | `deployment.md` | 0.5 to 1 | 0.25 | - | P1 |

**Group total:** build 25.5 to 36.5 days, tests 8 to 12.5 days, together 33.5 to 49 days.

## E. Setup, testing and checks

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| E1 | Storage and CDN setup | The R2 bucket and CDN, the GCS service account (Manu creates it), secrets in the Worker. | A post-deploy check script: the bucket can be read and written, the CDN answers. | R-88, R-89, R-18 | 1 to 1.5 | 0.25 to 0.5 | A2 | P1 |
| E2 | Test on real phones | Android 10 and above in the WhatsApp browser: video camera, a refused camera, login link, video playback, low-cost phone. This stays **manual**, with a written checklist. | Not automated. The WhatsApp browser and the camera cannot be driven by a script. | R-11, R-42, R-9 | 2 to 3 | - | D5 | P1 |
| E3 | Acceptance suite | Turn the checks in section 13 (QA) of the requirements into an automated end-to-end suite (app logic, Worker and a Frappe test site). Run it before each release. | This task is the suite. | Section 13 | 2 to 3 | - | all | P1 |
| E4 | One local test command | A script that runs everything on a developer's machine: `flutter analyze`, `flutter test`, the architecture check, the Worker tests, `wrangler deploy --dry-run`, and the Frappe tests on a local test site. A short note on how to run it. A git pre-push hook runs the quick checks (analyze, unit tests, architecture check) so a push cannot skip them. The hook lives in the repo (`.githooks/`), and each developer sets it once with `git config core.hooksPath .githooks`. The script sets its own tool paths, so it also works when a push starts from VS Code, and it prints a clear message about what failed. (CI can come later. It is not planned.) | This task is the runner and the hook. Check once that a failing check blocks a push from VS Code and from a terminal. | `architecture-tenets.md` | 1 to 1.5 | - | - | P1 |
| E5 | Test data and fixtures | Fake students (with siblings), batches, enrollments and content on a test site. Recorded Frappe answers for the Worker's contract tests. | This task supports all tests. | `tapapp/test/` | 1 to 1.5 | - | - | P1 |

**Group total:** build 7 to 10.5 days, tests 0 to 0.5 days, together 7 to 11 days.

## A. Decisions and work for other people (not in the totals)

| ID | Item | Who | Needed by |
|---|---|---|---|
| A1 | Confirm in writing that `journey_2026` is the deployed branch. Test `submit_artwork` on production with no header, a wrong header and a valid header. | Lead developer | before B1 |
| A2 | Approvals from the client for changes in `frappe_tap`: the `tapapp` module, new fields on `ProgramEnrollment` and `Student` writes (see "Rules for our changes"), and the feedback link message and its Glific flow change (O-28). | You, with the client | before B4 and before the link message |
| A3 | Content for the hardcoded flow (video links, quiz questions, assignment text, messages, audio, example works) in Hindi and English. | Manu coordinates | before B11 and D11 |
| A4 | Figma fixes F-1 to F-8: no deadline countdown, the waiting-state label, the "I watched it" button, the 40 versus 50 points mismatch. A copy of the Figma file for read access. | Designer | before D3 to D6 |
| A5 | The default skill tags. | Manu | before B9 and D8 |
| A6 | Which activity each kid sees first in the test. | Curriculum team | before the test |
| A7 | A low-cost used Android phone for testing. | Anand | before E2 |
| A8 | How the kids get the magic link (sent by the team to each kid). A sending plan and a message text. | Manu and the team | before the test |
| A9 | The product team's answers to the open decisions in section 11 (O-1, O-9, O-13, O-18, O-28). None of them blocks the P1 work. | Product team | before the test |

## How to cut (if the team is small)

The smallest slice that is a real test: login, one activity from Home through Watch, Quiz, Make and Results, with points. That is **B1 to B8, B10, C1 to C6, D0 to D8, D11 (or bundled content), D12, E1 to E5**. If time is short:
1. **Bundle the content in the app for the first test** (skip B11 and D11, about 6 to 9 days with tests). R-18 says download from the CDN, so this needs your agreement. Switch to the CDN in the next release.
2. **Skip "My projects" and the tags on the Me page** (parts of B8, B9 and D8, about 2.5 to 4 days with tests). Keep points and level.
3. **Leave P2 out:** the Gallery (B12, D9), Ask TAP (D10) and the deletion job (B13). Together this saves about 8 to 13 days. First ask if the test group needs the Gallery at all. R-96 (deletion) can wait until media piles up, but it must be done before the next phase.
4. **Do not cut the tests of B2, B5, B7 and C2.** They protect other children's data, the quiz answers and the points.
5. **Run E2 (real phones) in parallel** with the build, starting with the video camera and permission probes. Late bugs there cost the most.

## Risks that can add days

- **Reading the private Google Cloud bucket from the Worker** (C5) is not tested. If it fails, B6 and the Gallery copy need another plan.
- **Video size** (50 to 100 MB at 30 to 90 seconds): upload on weak connections may need compression in the browser, which may not be possible in the WhatsApp browser.
- **Changing `ProgramEnrollment`** needs the client's approval (A2). If approval is late, B4 to B8 are late.
- **The feedback link message** (O-28) needs a Glific flow change and approval. Without it, the kids see their feedback only when they open the app.
- **The Figma fixes** (A4) change some frames (the waiting label, the "I watched it" button, the countdown). Building before the fixes can mean small rework in D3 to D7 and in their tests.
- **`tapapp` has little test coverage and uses raw SQL,** so B1 to B3 may take the high number.
- **A local Frappe test site** (E4, E5) may take longer than planned. The backend tests depend on it. Without CI, someone has to run the tests before each release, so the local command must be fast and simple.

# v1 task breakdown (draft)

**Date:** 2026-11-02 (second version: automated tests are now included for each task)
**Purpose:** a list of the changes needed for the v1 test release, with a rough effort for each. We will use it to plan and to track the work.
**Source:** `v1-requirements.md` (it always wins), `tapapp-changes.md`, `backend-plan-feedback.md` and `build-bootstrap.md`.

## How to read this

- **Effort is in working days for one developer who knows the code.** Each task has a low and a high number. They are rough.
- **Two efforts for each task:** **Build** (write the code) and **Tests** (write the automated tests for it). A task is **done only when its tests pass on a developer's machine, with one command (E4).** There is no CI yet. The "Automated tests" column says what the tests check.
- **What stays manual:** the WhatsApp in-app browser, the phone camera and video playback cannot be automated. They are tested by hand on real phones (E2) with a written checklist.
- **Priority.** **P1**: needed for the mid-November test release. **P2**: in the requirements for v1, but it can follow the first test, or we ask if the test group needs it. Later items (events, a stronger login, tiered rewards and so on) are not listed. See section 2 of the requirements.
- **Depends on** lists the tasks that must be done (or at least started) first. A to E are the groups below.
- **Assumptions:** `journey_2026` is the deployed branch. The test group is 30 to 100 pre-registered kids. The flow is hardcoded: greeting, video, submission, quiz. Each kid gets a magic link. The three daily feedback windows stay as they are.
- **Dates.** The test release is in mid-November. This list was written on 2 November, so there were about 10 to 14 working days.

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
| B1 | Move the module | Copy only the `tapapp` folder and its DocTypes into `frappe_tap`, branch `journey_2026`. Do not copy the daily jobs or the `ca` hooks. The code reads a secret from a `Secrets` doctype that does not exist on `journey_2026`, so replace it (for example with the site config). Make `bench migrate` run without errors. | A basic check that the module can be imported and its DocTypes load after `bench migrate`. | R-46, `tapapp-changes.md` s.6 | 1 to 2 | 0.25 to 0.5 | A1 | P1 |
| B2 | Close the security holes | Remove guest access and the password and reset-code (OTP) code. Every call must carry one credential from the Worker. On every call, check that the student belongs to the phone. | Each call must refuse a request with no credential, a wrong credential, or a student who belongs to another phone. One more test fails if any call is still open to guests (`allow_guest`). | R-33, R-81, `tapapp-changes.md` s.2 | 1.5 to 2.5 | 1 to 1.5 | B1 | P1 |
| B3 | Remove the old model | Remove `Tapapp Learner`, `Tapapp Auth Profile`, streak, gems, archetype, the weekly cap, achievements and both daily jobs. Find the children of a phone from `Student` (a phone can be stored with 10 or 12 digits), and keep only students with an enrollment in an active batch. Write a patch that removes the old data. | Tests check that the right children are found for a phone in both forms (10 and 12 digits), for siblings, and for a student with no active batch or no enrollment. The removal patch must be safe to run twice. | R-34, R-39, R-48, LS4 | 1.5 to 2.5 | 1 to 1.5 | B2 | P1 |
| B4 | Step table and points settings | Create a new DocType, `Tapapp Step`. It holds one row for each step a student does (video marked as watched, each quiz answer, work sent). Each row links to the student's `ProgramEnrollment`, and also stores the student, the step type, the unit, the points and a unique `idempotency_key` (a key that stops the same step from being saved twice). `ProgramEnrollment` keeps only its summary point fields. Add a small settings DocType for the point values and the video minimum time. Agree the table and the writes to the point fields with the client first. | Tests check that sending the same step twice saves it only once (the database refuses the second row), that two calls at the same time do not make duplicates or wrong totals, and that the point values come from the settings and not from the code. | R-38, R-40, R-41, R-48, R-75 | 2 to 3 | 1 to 1.5 | B3, A2 | P1 |
| B5 | Server quiz | Build the quiz on the server. One call starts a quiz and one call answers a question. The server sends one question at a time, checks each answer, accepts answer N+1 only after answer N, stores every answer, and never sends the correct answer. | Tests check that answers must come in order, that answering the same question twice is handled, that every answer is stored, that **the correct answer never appears in any response**, and that a retake works. | R-91 | 2 to 3 | 1 to 1.5 | B4 | P1 |
| B6 | Submission path | Make a short upload link for the app, and call `submit_artwork` once for each upload. Stop the same upload from being sent twice. Use the Google Cloud service account for the file. | Tests check that `submit_artwork` is called exactly once for each upload (the call itself is faked in the test), that a repeated upload is ignored, and that a wrong file type is refused. | R-27, R-89 | 2 to 3 | 1 to 1.5 | B2, E1 | P1 |
| B7 | Valid or not valid, points, gate | Read `submission_validity` from the feedback. A result with grade 0, or with the text "technical issue", counts as not valid. Give +25 when the work is sent and +10 when valid feedback comes. Keep the next activity closed until the feedback is valid. | Tests check that valid feedback gives +10, that invalid feedback and grade 0 give nothing, that +25 is given at once, that points are given only once for each submission, and that the next activity is closed before valid feedback and open after it. | R-75, R-76, R-83, R-92 | 1.5 to 2.5 | 1 to 1.5 | B4, B6 | P1 |
| B8 | Feedback and "My projects" reads | Read the feedback (text, translated text, audio link), the valid flag, the list of projects (from `Submission` and the course assignments) and the student's points, and return them to the app. | Tests check the shape of each answer, and that a student cannot read another student's feedback. | R-16, R-56, R-87 | 1 to 2 | 0.5 to 1 | B7 | P1 |
| B9 | Placeholder tags and empty banner call | Add a fixed set of tags that is the same for every student (Manu provides them). Add a banner call that returns an empty list. | Tests check that both answers have the expected shape. | R-94, R-95 | 0.5 to 1 | 0.25 | B2 | P1 |
| B10 | Test group tools | Register the kids who are missing, and write a script that makes the magic links for the 30 to 100 kids. | Tests check that the Worker accepts a link made by the script, and refuses the same link after it was changed. | R-32, `whatsapp-link-login.md` | 1 to 1.5 | 0.5 | B3 | P1 |
| B11 | Content files for the CDN | Write a script that builds the content files for the CDN: JSON files for the units and the flow messages, and a manifest (a list of all files with a fingerprint of each), as in `content-spec.md`. The files must not contain the correct answers. Fix the old export: it reads the wrong table, and some doctypes and fields it needs are missing on `journey_2026`. | Tests check every file against its JSON Schema (the allowed shape), that no file contains an answer key, that the fingerprints match the manifest, and that the build fails if a language is missing. | R-18, R-91, `content-spec.md` | 2 to 3 | 1 to 1.5 | A3, E1 | P1 |
| B12 | Gallery copy to R2 | After valid feedback, copy the student's work to a separate place in R2. Build the list for the Gallery: valid work only, with the student's initials, in random order, 5 to 10 items each time. | Tests check that only valid work is copied, that copying twice is harmless, that the list shows initials and not names, and that it has 5 to 10 items. | R-59, R-85, R-88 | 2 to 3 | 1 to 1.5 | B7, E1 | P2 |
| B13 | Delete media on batch change | Delete the student's photos, videos and R2 copies when the student moves to a new batch. Find out who deletes the original files in GCS. | Tests check that media from the old batch is deleted and other media is kept. The job also has a "dry run" mode that only lists what it would delete. | R-96 | 1 to 1.5 | 0.5 to 1 | B12 | P2 |

**Group total:** build 19 to 30.5 days, tests 10 to 15 days, together 29 to 46 days.

## C. Worker (`worker/`, in the Flutter repo)

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| C1 | Remove the prototype AI | Remove the AI files `groq.js`, `tapbuddy.js` and `submission_review.js`, and the routes that use them. | A test checks that no AI route is left in the route list. | AP list in `production-readiness.md` | 0.5 | 0.1 to 0.25 | - | P1 |
| C2 | Login | Check the signed WhatsApp link. Issue a phone token, and after the student picks a name, a student token (`select_student`). Add rate limits. The token is in the part of the link after `#`. | Tests check a good link, an expired link, a changed link and a link for the wrong phone, the shape of the tokens, the rate limit, and that a student of another phone is refused. | R-31 to R-34, `whatsapp-link-login.md` | 2 to 3 | 1 to 1.5 | C1 | P1 |
| C3 | Per-student checks and the Frappe key | On every call, the Worker checks that the student belongs to the phone. The Frappe key stays a Worker secret, and the Worker sends it in the `Authorization` header to Frappe. | Tests check that every route needs a token, that the key never appears in a response or a log, and that the header is sent to Frappe (Frappe is faked in the test). | R-81, R-82 | 1 to 1.5 | 0.5 to 1 | C2 | P1 |
| C4 | Routes | Add the Worker routes: home, steps, quiz start and answer, upload link and submit, feedback, my projects, gallery and the banner list. | Contract tests compare the Worker's answers with recorded real Frappe answers. Another test checks that errors become friendly error codes. | `build-bootstrap.md` s.7 | 3 to 5 | 1.5 to 2.5 | C3, B4-B8 | P1 |
| C5 | Google Cloud storage access | Read the private submission bucket from the Worker, with the service account's HMAC keys kept as Worker secrets. Make short-lived upload and read links. Check that photos and videos play. This is a risk, because it is not tested yet. | Unit tests check the link signing. An integration test uses a test bucket and runs only when the secrets are present. Playback is tested by hand (E2). | R-88, R-89 | 1.5 to 2.5 | 0.5 to 1 | E1 | P1 |
| C6 | Safe repeats | Use an idempotency key on every step, and make sure one upload causes only one `submit_artwork` call. | Tests send the same key twice, and the same work uploaded twice, and check that only one record is made. | R-38, R-89 | 0.5 to 1 | 0.25 to 0.5 | C4 | P1 |

**Group total:** build 8.5 to 13.5 days, tests 4 to 7 days, together 12.5 to 20 days.

## D. Flutter app (`lib/`)

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| D0 | Clean up the prototype | Remove the hard-coded values, the AI calls, "2 units a week", streak and gems. Bundle the fonts in the app. Replace the 7.6 MB loader GIF. Show friendly errors with a Retry button. | `flutter analyze` and the architecture check pass on a developer's machine. A test checks that no AI client and no streak or gem code is left. | R-39, R-43, R-44, AP1-AP9 | 2 to 3 | 0.25 to 0.5 | - | P1 |
| D1 | App shell | Build the three tabs (Home, Gallery, Me), "Who is learning", the Welcome back screen, the TAP Buddy picture as the profile picture, the offline screen with a Retry button, Settings and Edit profile. | Widget tests check the tabs, the name picker, the offline screen and Retry, and the screen changes after login and logout. | R-1 to R-8, R-60, R-71, R-73, R-74 | 3 to 4 | 1 to 1.5 | D0 | P1 |
| D2 | Login screens | Open the magic link, show the name picker when the phone has several children, and let the student switch profile. | Widget tests check a good link, an expired link, that one child goes straight in, and that several children show the picker. | R-31 to R-34 | 1.5 to 2 | 0.5 to 1 | C2 | P1 |
| D3 | Watch step | Show the greeting and the video. Add an "I watched it" button that turns on after 5 minutes (a server setting) and gives +10 points. | Widget tests check the button when it is off and when it is on, and that tapping it saves the step only once. | R-61, R-62, R-90 | 1.5 to 2 | 0.5 to 0.75 | D1 | P1 |
| D4 | Quiz step | Show one question at a time from the server, with right or wrong feedback, the points and a summary. | Widget tests check the whole flow, a right and a wrong answer, the summary, and a retry after the connection is lost. | R-67, R-91 | 2 to 3 | 0.75 to 1 | D5, C4 | P1 |
| D5 | Make step | Let the student take or choose a photo or video. Make the photo smaller as a JPEG, upload it with a retry, show a message when the camera is refused, limit the video to 90 seconds, and offer "do it later". | Unit tests check the JPEG resize, the size and length limits and the retry logic. Widget tests check the message when the camera is refused and the "pending" state. The camera itself is tested by hand (E2). | R-9, R-11 to R-13, R-63, R-64, R-66 | 3 to 4.5 | 1 to 1.5 | D3, C4 | P1 |
| D6 | Results chat | Build the Results chat: the feedback messages with speaker icons, the "Yes" button, the "YOU WON" card, the points reveal, the picture badge, the "not valid" case with "send again", and the label "Points will be provided after feedback". | Widget or golden (screenshot) tests check each state of the chat. A test checks that the points show only after the tap. Another checks that a not-valid result shows "send again". | R-68, R-69, R-75, R-76, R-83, F-6 | 3 to 4 | 1 to 1.5 | D4, C4 | P1 |
| D7 | Home | Build Home: the greeting, the points, one activity card with its states, and a banner place that is empty in v1. | Widget tests check every state of the card and the empty banner place. | R-4, R-94 | 2 to 2.5 | 0.5 to 0.75 | D1 | P1 |
| D8 | Me | Build Me: the profile, level, points, My projects and the placeholder tags. | Widget tests check the page with projects and without, and the level and the tags. | R-7, R-87, R-95 | 2 to 3 | 0.5 to 0.75 | D1, B8 | P1 |
| D9 | Gallery | Build the Gallery: valid work, the student's initials, the full-screen viewer and "Load more". | Widget tests check an empty Gallery, a full grid and the viewer. | R-6, R-59, R-85 | 2 to 3 | 0.5 to 1 | B12 | P2 |
| D10 | Ask TAP | Show the Ask TAP panel with ready-made questions that fit the step. | A widget test checks that the questions change with the step. | R-70 | 1 to 1.5 | 0.25 to 0.5 | D1 | P2 |
| D11 | Content loader | Download the manifest and the files, keep them in a cache, keep a small first-run copy in the app, and retry a failed download. | Unit tests check that a changed fingerprint downloads only that file, that the first-run copy works with no connection, that a failed download is retried, and that a unit already open keeps its old files. | R-18 to R-22, R-79 | 2 to 3 | 1 to 1.5 | B11 | P1 |
| D12 | Build and deploy | Run `scripts/build_web.sh`, and deploy the app to hosting and the Worker, with the secrets. | The local test command builds the web app and runs `wrangler deploy --dry-run` (a deploy that changes nothing). | `deployment.md` | 0.5 to 1 | 0.25 | - | P1 |

**Group total:** build 25.5 to 36.5 days, tests 8 to 12.5 days, together 33.5 to 49 days.

## E. Setup, testing and checks

| ID | Task | What | Automated tests | Refs | Build | Tests | Depends on | Priority |
|---|---|---|---|---|---|---|---|---|
| E1 | Storage and CDN setup | Set up the R2 bucket and the CDN. Manu creates the Google Cloud service account. Put the secrets in the Worker. | A check script, run after each deploy, confirms that the bucket can be read and written and that the CDN answers. | R-88, R-89, R-18 | 1 to 1.5 | 0.25 to 0.5 | A2 | P1 |
| E2 | Test on real phones | Test on Android 10 and above in the WhatsApp browser: the video camera, a refused camera, the login link, video playback and a low-cost phone. This stays **manual**, with a written checklist. | Not automated. A script cannot drive the WhatsApp browser or the camera. | R-11, R-42, R-9 | 2 to 3 | - | D5 | P1 |
| E3 | Acceptance suite | Turn the checks in section 13 (QA) of the requirements into an automated end-to-end suite that covers the app logic, the Worker and a Frappe test site. Run it before each release. | This task is the test suite itself. | Section 13 | 2 to 3 | - | all | P1 |
| E4 | One local test command | Write one script that runs every check on a developer's machine: `flutter analyze`, `flutter test`, the architecture check, the Worker tests, `wrangler deploy --dry-run` and the Frappe tests on a local test site. Add a short note on how to run it. Add a git `pre-push` hook (a script that Git runs before a push) that runs the quick checks (analyze, unit tests and the architecture check), so a push cannot skip them. The hook lives in the repo in `.githooks/`, and each developer turns it on once with `git config core.hooksPath .githooks`. The script sets its own tool paths, so it also works when a push starts from VS Code, and it prints a clear message about what failed. CI is not planned for now. | This task is the test runner and the hook. Check once that a failing check blocks a push, both from VS Code and from a terminal. | `architecture-tenets.md` | 1 to 1.5 | - | - | P1 |
| E5 | Test data and fixtures | Prepare test data on a test site: fake students (including siblings), batches, enrollments and content. Record real Frappe answers for the Worker's contract tests. | This task supports all the other tests. | `tapapp/test/` | 1 to 1.5 | - | - | P1 |

**Group total:** build 7 to 10.5 days, tests 0 to 0.5 days, together 7 to 11 days.

## A. Decisions and work for other people (not in the totals)

| ID | Item | Who | Needed by |
|---|---|---|---|
| A1 | Confirm in writing that `journey_2026` is the deployed branch. Test `submit_artwork` on production with no header, a wrong header and a valid header. | Lead developer | before B1 |
| A2 | Approvals from the client for changes in `frappe_tap`: the `tapapp` module, the new `Tapapp Step` table, writes to the existing point fields of `ProgramEnrollment`, and `Student` writes (see "Rules for our changes"), and the feedback link message and its Glific flow change (O-28). | You, with the client | before B4 and before the link message |
| A3 | Content for the hardcoded flow (video links, quiz questions, assignment text, messages, audio, example works) in Hindi and English. | Manu coordinates | before B11 and D11 |
| A4 | Figma fixes F-1 to F-8: no deadline countdown, the waiting-state label, the "I watched it" button, the 40 versus 50 points mismatch. A copy of the Figma file for read access. | Designer | before D3 to D6 |
| A5 | The default skill tags. | Manu | before B9 and D8 |
| A6 | Decide which activity each kid does first in the test. | Curriculum team | before the test |
| A7 | A low-cost used Android phone for testing. | Anand | before E2 |
| A8 | How the kids get the magic link (sent by the team to each kid). A sending plan and a message text. | Manu and the team | before the test |
| A9 | The product team's answers to the open decisions in section 11 (O-1, O-9, O-13, O-18, O-28). None of them blocks the P1 work. | Product team | before the test |

## How to cut (if the team is small)

The smallest slice that is a real test: login, then one activity from Home through Watch, Make, Quiz and Results, with points. That is **B1 to B8, B10, C1 to C6, D0 to D8, D11 (or bundled content), D12, E1 to E5**. If time is short:
1. **Bundle the content in the app for the first test** (skip B11 and D11, about 6 to 9 days with tests). R-18 says download from the CDN, so this needs your agreement. Switch to the CDN in the next release.
2. **Skip "My projects" and the tags on the Me page** (parts of B8, B9 and D8, about 2.5 to 4 days with tests). Keep points and level.
3. **Leave P2 out:** the Gallery (B12, D9), Ask TAP (D10) and the deletion job (B13). Together this saves about 8 to 13 days. First ask if the test group needs the Gallery at all. R-96 (deletion) can wait until media piles up, but it must be done before the next phase.
4. **Do not cut the tests of B2, B5, B7 and C2.** These tests protect each child's private data, keep the quiz answers secret, and make sure the points are right.
5. **Run E2 (real phones) in parallel** with the build, starting with the video camera and with what happens when the camera is refused. Bugs found late there cost the most.

## Risks that can add days

- **Reading the private Google Cloud bucket from the Worker** (C5) is not tested. If it fails, B6 and the Gallery copy need another plan.
- **Video size** (50 to 100 MB at 30 to 90 seconds): upload on weak connections may need compression in the browser, which may not be possible in the WhatsApp browser.
- **The client's approval** (A2) is needed for the new `Tapapp Step` table and for writing to the point fields of `ProgramEnrollment`. If the approval comes late, tasks B4 to B8 are late too.
- **The feedback link message** (O-28) needs a Glific flow change and approval. Without it, the kids get no WhatsApp message with a link to their feedback. They see the feedback only when they open the app.
- **The Figma fixes** (A4) change some frames (the waiting label, the "I watched it" button, the countdown). Building before the fixes can mean small rework in D3 to D7 and in their tests.
- **`tapapp` has few tests and uses raw SQL,** so tasks B1 to B3 may take the high end of their range.
- **A local Frappe test site** (E4, E5) may take longer than planned. The backend tests depend on it. Without CI, someone has to run the tests before each release, so the local command must be fast and simple.

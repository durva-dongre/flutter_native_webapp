# What needs to change in `tapapp`

**For:** the author of the `tapapp` module (about 4,900 lines in `frappe_tap_dd`, branch `pal-v2`).
**Date:** 2026-11-02
**Read with:** `v1-requirements.md`, `system-understanding.md`, `whatsapp-link-login.md` and `backend-plan-feedback.md`.

## How to read this

The `tapapp` module will be added to `frappe_tap`, branch `journey_2026`, as a module in the same app (R-46). Only this module moves. The other branches are not needed.

**The requirements document always wins.** If this note and the requirements differ, we follow the requirements.

We read the code. We did not run it. Where we could not check something, this note says "not verified". You wrote the code, so you may know better. Please correct us.

**The short version.** `tapapp` was built as a teacher and class app with a password login and a game layer (XP, streaks, gems, levels, archetypes). v1 is different: a test release for under 100 pre-registered kids, with a WhatsApp magic link, no streaks and no weekly limit. Some parts can be kept. Most of the login and the progress model must change.

## 1. What stays, what changes, what goes

| Part | Decision |
|---|---|
| Profile and auth plumbing, the Postgres access, the shape of the content export | Keep, with changes |
| Login with a password, the OTP reset, `check_phone`, `admin_code`, `teacher` | Remove |
| `Tapapp Learner`, `Tapapp Auth Profile` | Remove. Progress goes into `ProgramEnrollment` (R-48) and children come from `Student`. |
| XP, streak, gems, level window, archetype, achievements, weekly cap | Remove from v1 (R-39, R-72, section 2 of the requirements) |
| Both daily jobs (`nightly_window_maintenance`, `tapapp_analytics_report`) | Leave out of v1 |
| Progress counters, the content export | Rewrite (sections 3 and 4) |
| Quiz, submissions, points rules, valid-feedback check | Missing. Add (section 4). |

## 2. Fix first: security

These must be fixed before any real child uses the module.

1. **Anyone can take over an account.**
   - `login_with_password` (`tapapp_auth.py:215-219`) sets the password at the **first** login. Anyone who knows a registered phone can claim it.
   - The reset OTP is a fixed `"000000"` (`tapapp_auth.py:6`, `:291`), and no message is sent.
2. **Anyone can read or change any learner's data.** These calls are open to guests and have no token check: `get_learner_state`, `get_learner_progress`, `get_learners_progress`, `enroll_course`, `record_activity`, `update_content_progress`, `get_learner_achievements` (`learner.py:334-495`, `achievements.py:38`). They take a `learner_id` and nothing else.
3. **XP comes from the caller.** `record_activity` takes `xp` from the request (default 10). Anyone can send a huge number. The server must decide the points (R-37, R-75).
4. **Award and webhook calls only need "logged in".** `submission_verified_webhook` (`learner.py:596`) and `award_achievement` (`achievements.py:46`) have no role or key check. Anyone who is logged in could award points.
5. **Export calls only need "logged in" too** (`export.py:544`, `:604`) and return quiz data.
6. **No rate limit** on `login_with_password`, `check_phone` or the OTP calls. `check_phone` also shows whether a phone is registered.
7. **Points are added again on every retry.** There is no idempotency key. The cap check and the update are two separate steps, so two calls at the same time can both pass (R-38).
8. **Token design.** The token lasts 90 days and refreshes without a check. The secret comes from a `Secrets` doctype and is cached in Redis. There is no way to revoke a token.
9. **Commits in the middle of a request** (`frappe.db.commit()` and raw `SAVEPOINT` in many places) can leave half-written data after an error.
10. **Fixed values in code:** the OTP, the token lifetimes, `SUBMISSION_XP = 25`, `max_weekly_activities or 2`, the owner `'Administrator'` on raw inserts (`achievements.py:63`, `learner.py:400`), and the level `"Level 1"`. R-41 says these must be settings on the server.
11. **Raw SQL with column names built from the request** (`set_clause`, `col_list`). It is filtered today, so it is safe, but it is fragile.

**What to do.** Remove `allow_guest` from all of these. Every call must take **one Worker credential** (an API key or an HMAC), and the Worker tells you the phone and the student. Check on each call that the student belongs to that phone (R-81). Never trust a typed phone number (R-33).

## 3. Change to match the requirements

| Area | Today | What we need | Requirement |
|---|---|---|---|
| **Login** | A password. Teacher and class model (`teacher`, `admin_code`, grade, division, roll number). | A signed WhatsApp magic link that carries the phone. The **Worker** checks the link and signs the token. The backend trusts only the Worker. No password and no OTP. | R-31 to R-34, R-81, `whatsapp-link-login.md` |
| **Children of a phone** | A `Tapapp Auth` row for each phone, with a profile table. Nothing in `tapapp` creates the profile rows (not verified where they come from). `Auth Profile.student` is a link that is not unique. | Read the children from `Student where phone = X`, in both the 10-digit and 12-digit forms. Only students with an enrollment in an active batch. No profile table. | R-34, LS4 |
| **Progress record** | `Tapapp Learner` with `xp`, `level`, `streak` and more, plus `Tapapp Enroll`. | One record, `ProgramEnrollment`. It is empty today because the old Summer Program engine is off. You fill the fields you need. No second copy. | R-48 |
| **Progress counters** | `update_content_progress` keeps counters (`videos_completed`, `quizzes_completed`, `submission_index`) with GREATEST. | A record for each step (video watched, each quiz answer, work sent), each with an idempotency key. | R-38, R-40 |
| **Points** | The client sends the XP. `SUBMISSION_XP = 25` is given when a webhook arrives. | The server decides. Video +10, sharing the work +25 (at once), each correct quiz answer +1, correct submission +10 (after valid feedback only). Values are settings. | R-37, R-41, R-75 |
| **Level** | A string, `"Level 1"` by default. | Worked out from the points with thresholds in settings. | R-41 |
| **Profile edits** | Written to the Tapapp tables only. `school` cannot be edited. | Writing to `Student` is a change to production data and needs approval. Ask before you add it. | R-74, "Rules for our changes" |
| **Content export** | `export_program_content` returns the whole payload in the HTTP answer. `include_r2` is not used. `export_content` reads the table `Citizenship Content` (the wrong one). It includes quiz data. | Write JSON files to R2 as in `content-spec.md`, one for each unit and language, with a manifest. Remove the correct answers from files the browser gets. | R-18, R-91 |

## 4. Missing: please add

1. **The quiz on the server (R-91).** Start a quiz and answer one question. The server sends one question at a time, checks each answer, accepts answer N+1 only after answer N, and stores the attempt and every answer. The correct answer never goes to the browser.
2. **Submissions (R-27, R-89).** Nothing links to `Submission` today. Add: give the app a short upload link (the Worker holds the Google Cloud service account), then call `submit_artwork(assignment_id, student_id, submission)` once for each upload. The call has no duplicate check, so do not send the same work twice.
3. **Valid or not valid (R-76, R-92).** Read `Submission.submission_validity`. A result with grade 0 or the text "technical issue" counts as **not valid**. Give the +10 only for a valid result. Nothing checks this today.
4. **The valid-feedback gate (R-83).** The next activity opens only after the work is submitted and the feedback is valid.
5. **"My projects" data (R-87),** from `Submission`, the points and steps you store, and the course assignments.
6. **Placeholder tags (R-95).** A fixed set for every student. No field per student.
7. **Deletion (R-96).** Photos, videos and the R2 copies are deleted when the student moves to a new batch.
8. **A banner call that returns an empty list (R-94).** No event code in v1. We only leave room for it.
9. **Tools for the test group:** register the kids who are missing, and a script that makes the magic links for the 30 to 100 kids.

## 5. Leave out of v1

- Streaks, gems, archetypes, achievements, the weekly cap and the level window (R-39, R-72).
- Both daily jobs. The analytics job sends data to an outside Apps Script address, which we do not need.
- The teacher bulk tools: `search_student`, `get_bulk_students`, `bulk_update_students`.
- `Tapapp Content` news and events (events are v1.1).

## 6. Moving the module to `journey_2026`

We compared the two branches. Copy **only** `tapapp/` and its DocTypes. These items fail or differ on `journey_2026`:

| Item | Problem |
|---|---|
| **`Secrets` doctype** | It is not on `journey_2026`. `tapapp_auth.py:14-20` and the analytics job (`:95-96`) need it, so the login fails. Use the site config for the secret, or add the doctype. |
| **Missing DocTypes** | `Assignment Submission Rule`, `Learning Unit Translation` and `Quiz Translation` do not exist there. The export reads their tables (`export.py:204`, `:299`, `:380` and others). |
| **Missing fields** | `Course Level`: `course_image_url`, `download_url`, `translations`, `zip_*`. `Video Class` and `Video Translation`: `video_url`. `Learning Unit`: `translations`. The export reads these. |
| **`hooks.py`** | The two daily jobs are not on `journey_2026`. Do not add them in v1. The `hooks.py` on `pal-v2` also has live `ca.*` entries and a comment block (lines 49-77) that mention the `ca` module. **Do not copy those.** |
| **Python packages** | The code imports `jwt` and `psutil`. `requirements.txt` on `journey_2026` does not list them. Frappe normally installs them, but we did not verify it. If login moves to the Worker, `jwt` is not needed. |
| **Tests** | The files in `tapapp/test/` need a live server and fixed test data. Do not ship them as unit tests. |
| **Migrations** | There are no `tapapp` patches or fixtures to carry. DocType files are picked up by `bench migrate`. Removing `Tapapp Learner` or adding a unique index needs a patch. |

**Good news.** The module does not import `summer_program`, `journey`, `api.py`, `glific_*` or `ca.*`, so it is self-contained. It uses raw Postgres SQL, and `journey_2026` is also Postgres.

`ProgramEnrollment` has the same fields on both branches. It already has point fields (`total_points`, `total_quiz_points`, `total_submission_points` and others) but no step or idempotency fields. Adding fields to it is a change to a production doctype, so please tell us which fields you need before you add them.

## 7. Suggested order (smallest useful step first)

1. Copy `tapapp/` and its DocTypes only. Solve the `Secrets` problem. Do not copy the daily jobs or the `ca` hooks. Check that `bench migrate` passes on `journey_2026`.
2. **Close the security holes** (section 2): no guest access, one Worker credential on every call, a check that the student belongs to the phone.
3. **Remove the password and OTP code,** `Tapapp Learner`, `Tapapp Auth Profile`, streaks, gems, archetype, the weekly cap and both jobs. Read the children from `Student`.
4. **Add the step log in `ProgramEnrollment`,** with idempotency keys, and a small settings table for the point values.
5. **Add the server quiz.**
6. **Add the submission call and the valid-feedback check,** and the +10 award.
7. **Add "My projects", the placeholder tags and the empty banner call.**
8. **Fix the content export** to write the CDN files from `content-spec.md`.
9. **Add the deletion on batch change** and **rewrite the tests** as Frappe unit tests.

Please send us the plan for steps 1 to 4 before you start. If anything in the requirements is not clear, ask. Do not guess.

## 8. Please check these for us

- Where do the `Tapapp Auth Profile` rows come from today? We found no code that creates them.
- Does any `Student` user (role) really exist, so that `Tapapp Learner` read access for the `Student` role matters?
- Are `PyJWT` and `psutil` installed on the production server?
- Is anything outside `tapapp/` and `hooks.py` using these DocTypes? We found nothing.

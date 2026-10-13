# DesignRadar — Project Status

Last verified: **2026-10-13**. Every claim below was checked against the
codebase or a live API call, not recalled.

---

## 1. Snapshot

|                                                                           |                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| Pipeline (discover → classify → score → dedupe → store → digest → notify) | **complete**                                      |
| Test suite                                                                | **786 pass / 0 fail** (161 suites)                |
| Lint                                                                      | **72 files, 0 syntax errors**                     |
| Edge source mirror (`_shared/`)                                           | **in sync**                                       |
| Automated delivery to Email (Resend)                                      | **live** — cron→function verified; one scheduled delivery still to observe (§4) |
| Version control                                                           | **none** — this directory is not a git repository |

---

## 2. Complete (Phases 1–10 + Multi-Source Expansion)

Phases 1–10 are implemented and tested. `PROJECT_SPEC.md` is the authority.

- **Discovery** — provider-abstracted `searchWeb()` (Serper), no LinkedIn
  scraping, no authentication. **Four supported sources**: LinkedIn, Greenhouse,
  Ashby, Lever. Broad search terms: `Senior Product Designer`, `Product Designer`,
  plus remote and domain lanes across all sources.
- **Normalization / dedup** — canonical job URL as the dedup key (works across
  all four sources).
- **AI classification** — Gemini structured JSON, validated before persistence,
  status-aware retries with jittered backoff (§14 config rules).
- **Scoring + gating** — eligibility, confidence, recency; Junior roles rejected.
- **Persistence** — Supabase, 5 SQL migrations in `supabase/migrations/`.
- **Digest + notification** — Email via Resend; posts marked sent only after a
  confirmed delivery.
- **Scheduling** — Edge Function `daily-radar` + two Postgres cron jobs.
- **Observability** — stage logging with source identification; errors surfaced with causes.

### Recent work (this session)

- **Multi-source expansion** — Added Greenhouse, Ashby, and Lever as discovery
  sources alongside LinkedIn. New URL normalization for each source in
  `src/utils/normalize-url.js`. Multi-source query generation in
  `src/search/queries.js` with budget allocation across sources. Updated
  `src/discovery/index.js` and `src/search/search-web.js` to handle multiple
  sources. Added comprehensive tests in `test/normalize-url-multi-source.test.js`,
  `test/queries-multi-source.test.js`, and `test/discovery-multi-source.test.js`.
- **Multi-source acceptance suite** (`test/multi-source-acceptance.test.js`) —
  one test per requirement: LinkedIn queries preserved; Greenhouse/Ashby/Lever
  results enter the shared pipeline; per-source URL normalization; cross-query
  dedup; existing-DB-record dedup; single-source failure isolation; role-gate
  handling of non-product-design and Junior posts; recency/timestamp behaviour;
  a four-source digest; email delivery and sent-status tracking; and the Edge
  handler. Two of these initially failed because they were written against APIs
  that do not exist (a failure-injecting provider that was never passed in, and
  a `deliverDigest` `sentPostCount` / `markPostsAsSent` contract the delivery
  module never had); both were corrected to exercise the real contracts with
  unchanged intent, and one had an invalid Lever fixture URL and an incorrect
  `.in(column, values)` mock signature. `searchWeb()` now also accepts a
  provider **function** via `options.provider` (additive) so a failing source
  can be driven deterministically in tests.
- **Validation (this session)** — `npm test` → **786 pass / 0 fail** (161
  suites, includes `pretest` Edge sync); `npm run lint` → 72 files, 0 syntax
  errors; `npm run edge:check` → shared sources up to date; `npm run
  smoke:multi-source` → **24/24 checks passed**. The multi-source changes are
  **local only**: the Edge Function was not redeployed from this session, and no
  production schedule or database data was touched.
- **Isolated multi-source smoke test** (`scripts/smoke-multi-source.js`,
  `npm run smoke:multi-source`) — runs the real `runRadar()` in `discovery` mode
  over fixtures covering all four sources, with the search provider, the Gemini
  classifier, and the database injected and `globalThis.fetch` replaced by a
  thrower. Verifies source coverage, URL normalization/dedup, keyword filtering,
  stale handling, role-policy elevation, and canonical persistence end to end
  without credentials, network, or a database. This is the safe substitute for a
  live `npm run radar`, which would spend real API quota and write production
  rows.
- **Profile role policy** (`src/profile/role-policy.js`): `Mid`, and `Unknown`
  on `Product Designer` / `UX Designer` / `UX/UI Designer`, resolve to
  `Senior` for scoring _and_ storage; `Junior` never resolves upward and fails
  the eligibility gate. Documented in PROJECT_SPEC §11/§13/§14/§16 and
  AGENTS.md; the classification prompt is unchanged.
- **`Product Designer` added as a search term** with its own dedicated query
  lane.
- **4-hour cron job switched from `discovery` to `full`**, so a newly found
  post is delivered to ntfy within one run instead of waiting for the daily
  digest. Empty digests are not sent; already-sent posts are never repeated.
- **`scripts/enable-schedule.js`** (`npm run schedule:enable`) automates the
  whole deployment: link → secrets → deploy → cron credentials → migration →
  verify. Idempotent; secrets never appear in argv or logs. Credentials go to
  **Supabase Vault** (`design_radar_supabase_url`,
  `design_radar_service_role_key`), not `ALTER DATABASE`, which Supabase
  hosted Postgres does not allow.
- **Edge/Node specifier conflict resolved with an import map.** `src/` keeps
  the bare `@supabase/supabase-js` specifier so Node and the test suite load
  it; `supabase/functions/import_map.json` maps it to `npm:` for the Edge
  bundler. Passed via `--import-map` in `edge:deploy`, `edge:serve`, and
  `schedule:enable`.
- **ntfy Deno bug fixed** (`src/notifications/ntfy.js`): `Buffer.from` in the
  header encoder crashed the function in Edge runtime
  (`ReferenceError: Buffer is not defined`) — the cause of the 08:00 UTC
  delivery failure. Replaced with `TextEncoder`; regression test added.
- **pg_net timeout raised to 120000 ms** in `005_phase9_scheduling.sql`;
  pg_net's 5000 ms default cut every `full` run's HTTP outcome off at 5 s.

---

## 3. Tooling installed

| Tool            | State                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| Node.js         | v26.3.1, npm 11.16.0                                                                          |
| Supabase CLI    | **2.119.0** (`brew install supabase/tap/supabase`)                                            |
| Docker / colima | **not installed** — not required; only needed for `functions serve` and `db pull` / `db diff` |
| psql            | not installed — `supabase db query --linked` is the substitute                                |

---

## 4. Delivery chain is live — one confirmation outstanding

Setup is done, and a pg_cron-originated invocation has been observed end to end
(cron → Vault → `net.http_post` → Edge Function → HTTP 200). What has not been
seen yet is a **scheduled** run delivering a message to ntfy; the only delivery
so far was triggered by hand.

| #   | Item                      | State                                                                                                          |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | `supabase login`          | **done** — CLI authenticated, project linked                                                                   |
| 2   | `npm run schedule:enable` | **run** — secrets uploaded, Vault seeded, `005_phase9_scheduling.sql` applied, both jobs active                 |
| 3   | `npm run notify:test`     | **done** — HTTP 200 from ntfy.sh at 09:56:14 UTC                                                               |
| 4   | Scheduled invocation      | **done** — a one-off job (jobid 7) fired through pg_cron at 10:17 and 10:18 UTC; both returned `200`,
    `timed_out = false`, `{"mode":"digest"}` — then was unscheduled                             |
| 5   | Scheduled **delivery**    | **not yet observed** — needs a scheduled run that finds new qualified posts; next one is 12:00 UTC              |

### Evidence

- `cron.job` → jobid 5 `design-radar-discovery` (`0 */4 * * *`), jobid 6
  `design-radar-digest` (`0 7 * * *`), both `active`.
- `cron.job_run_details` → two succeeded `DO` blocks on 2026-10-06
  (07:00 digest, 08:00 discovery). Both are the cron body; the HTTP outcome
  lives in `net._http_response`.
- `net._http_response` → id 1 (07:00): `200`, `{"mode":"digest", candidates:0}`
  — correct silence, nothing was pending. id 2 (08:00): `timed_out = true` at
  pg_net's default 5000 ms — the `full` run outlived it (the function kept
  running; see the timeout fix below).
- The 08:00 run discovered 7 posts, then failed delivery with
  `ntfy notification failed: network error: Buffer is not defined`
  (`notifications.status = 'failed'`, 08:00:18 UTC).
- **Fixed**: `src/notifications/ntfy.js` used `Buffer.from` in a header encoder
  that runs in Deno, where `Buffer` does not exist. Replaced with `TextEncoder`;
  regression test added. Redeployed 2026-10-06 ~09:55 UTC.
- After the fix: `npm run notify:test` → 200, and `POST …/daily-radar
  {"mode":"digest"}` → `{"success":true,"notificationSent":true}` at 09:56:42
  UTC. `linkedin_posts`: **14 notified, 0 pending**. `notifications`: 3 ntfy
  `sent`, 1 `failed` (the historical Buffer row).
- Both jobs were re-applied with `timeout_milliseconds := 120000`, so future
  scheduled runs record a real status and body instead of a 5 s timeout.
- **Cron path proven**: a temporary job (`design-radar-verify`, jobid 7) ran
  through pg_cron at 10:17:00 and 10:18:00 UTC with the same Vault lookup and
  `net.http_post` shape as production. Both fired `succeeded`, and
  `net._http_response` ids 3 and 4 recorded `status_code = 200`,
  `timed_out = false`, `{"success":true,"mode":"digest",…}`. It was then
  unscheduled; only jobs 5 and 6 remain active.

### To finish — watch the next scheduled run

```sql
-- HTTP outcome of each scheduled invocation (newest first):
select id, status_code, timed_out, left(content, 200), created
  from net._http_response order by created desc limit 5;

-- the cron side (no `jobname` column — join cron.job if you need names):
select jobid, status, start_time from cron.job_run_details order by start_time desc limit 5;

-- delivery side:
select provider, status, count(*), max(sent_at) from notifications group by 1, 2;
```

The next discovery run is **12:00 UTC (13:00 Africa/Lagos)**. Expect
`status_code = 200` with `mode = "full"`; a message only appears if new
qualified posts exist (empty digests are silence by design). The next digest
run is 07:00 UTC. The 07:00 run on 2026-10-06 returned 200 with 0 candidates —
correct silence, nothing was pending at that moment.

---

## 5. What will actually be delivered

Every 4 hours (01:00, 05:00, 09:00, 13:00, 17:00, 21:00
Africa/Lagos) the cron job runs mode `full`. A post reaches ntfy only if it:

1. classifies to `status = 'qualified'` — recruiting post, product design role,
   confidence or title exemption, not Junior;
2. is `is_notified = false` — never sent before;
3. has `discovered_at` inside the 168-hour window and falls within the 50-row,
   relevance-ordered cap;
4. is confirmed delivered by ntfy (otherwise it stays queued and the next run
   retries it).

If nothing passes, **no message is sent** — silence is the design, not a failure.
The daily 08:00 job (`mode: digest`) is a re-delivery safety net and normally
has nothing to send.

---

## 6. Known risks and gaps

- **A scheduled delivery has not been observed yet.** The 07:00 run completed
  with HTTP 200 (nothing pending); the 08:00 run hit the `Buffer` bug, which is
  fixed and redeployed. Trust the schedule only after the SQL in §4 shows a
  `200` and a `sent` row from a run nobody triggered by hand.
- **The ntfy topic is open.** `NTFY_TOKEN` is empty; anyone who learns the
  topic can read or post to it. Set a token and re-run `npm run notify:test`.
- **No retry scheduling.** `retryAfterMs` is returned but nothing consumes it;
  failures are retried only when the next job runs.
- **Dual-runtime import specifier.** `src/` must use the bare
  `@supabase/supabase-js` specifier (Node loads it from `node_modules`) while
  the Edge bundler requires `npm:`. The translation lives in
  `supabase/functions/import_map.json`, passed to every `functions deploy` /
  `serve` call; `test/edge-sync.test.js` fails if either side drifts.
- **`_shared/` is generated.** Never edit it — `npm run edge:sync` overwrites
  it and `npm run edge:check` fails when stale.
- **Migrations are not CLI-managed.** Files are numbered
  (`001_initial_schema.sql`), which `supabase db push` does not accept. Apply
  them explicitly with `supabase db query --linked -f <file>`. Never re-run
  001–004 against a database that already has data.
- **`src/index.js` has partial test coverage.**
- **Discovery is search-index driven, not exhaustive.** Greenhouse, Ashby, and
  Lever coverage comes from Google/Serper indexing the target domains, not from
  their public APIs. A posting that is not indexed (or is indexed outside the
  `timeRange` window) is not discovered. This is a deliberate trade-off: no new
  API dependency, and the same no-scraping rules that apply to LinkedIn.
- **The same job on two platforms stays two rows.** Deduplication is by canonical
  URL, so a role advertised on both LinkedIn and Greenhouse is stored twice.
  Merging on title/company similarity would risk collapsing two distinct
  openings, so it is intentionally not done.
- **No version control.** Initialize git before making further changes if you
  want a rollback point.

---

## 7. Where the answers live

| Question                               | File                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| What is this and what must it never do | `AGENTS.md`                                                                                                 |
| Detailed design and rules              | `PROJECT_SPEC.md` (§11 confidence, §13 profile policy, §14 scoring, §16 status, §19 scheduling, §20 digest) |
| How to run and deploy                  | `README.md`                                                                                                 |
| Deployment automation                  | `scripts/enable-schedule.js`                                                                                |
| Seniority / confidence policy          | `src/profile/role-policy.js`                                                                                |
| Mode routing and delivery gate         | `src/radar/run.js`, `src/notifications/pipeline.js`                                                         |
| Digest selection                       | `src/database/posts.js` (`getDigestCandidates`)                                                             |
| Schedules                              | `supabase/migrations/005_phase9_scheduling.sql`                                                             |

# DesignRadar — Current Project Status

Last updated: 2026-10-06

## Current Phase

Phase 10 — Email Notification Delivery (Resend)

Status: IMPLEMENTATION COMPLETE
Verification status: AWAITING USER CONFIRMATION OF LIVE EMAIL RECEIPT

---

## Architecture

Search:

- Serper

AI:

- Google Gemini
- Model: gemini-3.5-flash-lite

Database:

- Supabase

Notifications:

- Email via Resend
- Endpoint: https://api.resend.com/emails
- Topic/Channel: configured locally via email fields; NEVER expose API keys here

Runtime:

- Supabase Edge Function
- Function: daily-radar

Timezone:

- Africa/Lagos

---

## Phase 9 Status

### Completed

- [x] Supabase project linked
- [x] Supabase CLI installed
- [x] Edge Function deployed
- [x] Edge Function configured with verify_jwt
- [x] Edge Function secrets uploaded
- [x] Supabase Vault extension configured
- [x] Supabase URL stored in Vault
- [x] Supabase service-role key stored in Vault
- [x] Migration 005 applied
- [x] 4-hour discovery cron created
- [x] Daily 08:00 Lagos digest cron created
- [x] ntfy provider configured
- [x] ntfy delivery previously tested successfully

### Pending Verification

- [x] Confirm at least one scheduled cron execution — 2026-10-06 07:00 and
  08:00 UTC both recorded `succeeded` in `cron.job_run_details`
- [x] Confirm successful daily-radar execution from cron — the 07:00 digest
  returned HTTP 200 with `{"mode":"digest"}` (0 candidates; silence by design)
- [x] Confirm a scheduled invocation reaches the function — jobid 7 fired via
  pg_cron at 10:17 and 10:18 UTC, both `200` / `timed_out = false`
- [ ] Confirm resulting ntfy notification from a scheduled run — the 08:00 run
  failed on the `Buffer` bug (fixed and redeployed same day); a hand-triggered
  digest delivered all 7 pending posts at 09:56. Check the next scheduled run,
  12:00 UTC, with the SQL in §4

---

## Cron Schedule

Discovery:

- Job: design-radar-discovery
- Schedule: 0 _/4 _ \* \*
- Mode: full
- Frequency: every 4 hours

Digest:

- Job: design-radar-digest
- Schedule: 0 7 \* \* \*
- Lagos time: 08:00
- Mode: digest

---

## Important Configuration

Minimum relevance score:
60

Recency window:
168 hours

Gemini concurrency:
1

Gemini max retries:
2

Gemini timeout:
30000ms

Notification provider:
email

---

## Important Implementation Notes

Supabase hosted PostgreSQL does NOT use ALTER DATABASE
for DesignRadar cron credentials.

Cron credentials are stored in Supabase Vault:

- design_radar_supabase_url
- design_radar_service_role_key

Do not replace this with app.settings/current_setting configuration
unless the hosted Supabase environment is confirmed to support it.

The migration is:

supabase/migrations/005_phase9_scheduling.sql

The enablement script is:

scripts/enable-schedule.js

---

## Known Successful Commands

npm run edge:sync
npm run edge:check
npm run smoke:multi-source
supabase functions deploy daily-radar --import-map supabase/functions/import_map.json
npm run schedule:enable
npm run notify:test
select cron.run('design-radar-digest');   -- invokes a job out of schedule, zero search/Gemini cost

---

## Verification Query

Use:

SELECT \*
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 10;

Do NOT assume cron.job_run_details contains a `jobname` column.

To inspect scheduled jobs:

SELECT \*
FROM cron.job
WHERE jobname LIKE 'design-radar%';

---

## Current Rule for Future LLM Work

Before changing anything related to scheduling, notifications,
Supabase, migrations, or deployment:

1. Read this file.
2. Inspect the actual repository.
3. Check the current git diff/status.
4. Do not assume an earlier conversation represents the current state.
5. Do not recreate already-completed work.
6. Do not overwrite working configuration without first explaining why.
7. Never request or expose secrets from .env.

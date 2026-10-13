# 🎨 DesignRadar

> Personal job-intelligence application that discovers publicly discoverable **LinkedIn posts, Greenhouse job boards, Ashby job boards, and Lever job boards** advertising Senior+ Product Design opportunities, classifies them with AI, scores them for relevance, stores them in Supabase, and delivers a daily digest via Email (Resend).

---

## Architecture

DesignRadar is built with a strictly modular architecture enforcing clear separation of concerns across 9 pipeline stages:

```text
Discovery (Search Provider Adapter — LinkedIn, Greenhouse, Ashby, Lever)
  ↓
Normalization (Canonical Job URLs & Result Schema)
  ↓
Deduplication (Primary DB URL Check + In-Run Fingerprinting)
  ↓
Candidate Filtering (Inexpensive Keyword & Seniority Title Gate)
  ↓
AI Classification (Gemini Structured JSON)
  ↓
Relevance Scoring (Deterministic Signals → Eligibility Gate + Priority Band)
  ↓
Recency & Status Resolution (Fixed 168h Validity Window)
  ↓
Database Persistence (Supabase PostgreSQL)
  ↓
Digest Generation (168h Lookback, Verified 24h & Recent Discoveries Grouping)
  ↓
Notification Delivery (Provider Abstraction: mock / email / ntfy)
```

### Notification Delivery (Phase 7)

The rest of the application only ever calls `notifier.send(message)` and reads a
normalized result. No caller branches on the provider name, so adding Telegram
or email later means adding a module — not editing the pipeline.

```text
Digest (Phase 6)
  ↓
deliverDigest()                     src/notifications/deliver.js
  ↓
Duplicate check                     a prior notification already covered these posts?
  ↓
notifier.send(chunk)                mock prints · email POSTs HTML/JSON to Resend
  ↓
Provider confirms?                  HTTP 2xx from Resend (any id is recorded as-is)
  ↓
Record notification                 status sent|failed, provider_message_id, error_type
  ↓
Mark posts sent                     only after both the confirm and the record
```

Two rules this layer exists to enforce:

1. **A post is marked as sent only after the provider confirmed delivery *and*
   the notification was recorded.** Marking earlier would silently discard the
   very opportunities the digest exists to deliver.
2. **A failure marks nothing.** Failed, rate-limited, malformed and network
   outcomes record the failure and leave posts unsent, so the next run retries
   them. There is no in-process retry loop; `retryAfterMs` is preserved for
   scheduling in Phase 8.

Provider selection is via `NOTIFICATION_PROVIDER=email|ntfy|mock`. `.env.example`
ships `email`, so a configured deployment delivers for real; the code-level
fallback when the variable is unset is `mock`, so a missing variable degrades to
a print instead of failing the run. `mock` prints the digest and sends nothing,
and it does **not** mark posts as sent unless
`NOTIFICATION_MARK_MOCK_SENT=true` — a printed digest is not a delivery, and
marking on a preview would silently drop those posts from the next real email
digest.

### Directory Structure

```text
designRadar/
├── src/
│   ├── index.js           # CLI entry point and re-export surface
│   ├── radar/             # Orchestrator: runRadar(), mode resolution, run status
│   ├── search/            # Query generation, provider adapters, keyword filter
│   │   └── providers/     # serper / brave / mock search adapters
│   ├── discovery/         # Discovery phase orchestration
│   ├── filtering/         # Recency evaluation and status derivation
│   ├── ai/                # Gemini classification + deterministic scoring
│   │   ├── classify.js    #   Structured classification + retry policy
│   │   ├── prompt.js      #   Classification system prompt (module constant)
│   │   └── score.js       #   Deterministic relevance scoring
│   ├── database/          # Supabase client helper and query utilities
│   ├── notifications/     # Digest formatting/chunking + delivery abstraction
│   │   ├── config.js      #   Settings resolution and validation
│   │   ├── notifier.js    #   Provider factory
│   │   ├── mock.js        #   Local print-only provider
│   │   │   ├── email.js       #   Resend Email HTTP provider
│   ├── ntfy.js        #   ntfy HTTP API provider
│   │   ├── deliver.js     #   Send → record → mark orchestration
│   │   ├── pipeline.js    #   Digest/notification entry points
│   │   └── digest.js      #   Selection, grouping, chunking
│   └── utils/             # URL normalization, hashing, structured logger, env
├── scripts/
│   ├── lint.js            # Per-file syntax check
│   └── sync-edge-sources.js  # Mirrors src/ into the Edge Function bundle
├── supabase/
│   ├── config.toml        # Edge Function registration (JWT verification on)
│   ├── functions/
│   │   ├── daily-radar/   # Scheduled Edge Function entry point
│   │   └── _shared/       # Generated mirror of src/ (git-ignored)
│   └── migrations/        # SQL migration files
├── test/                  # Unit tests using Node.js native test runner
├── .env.example           # Template for environment variables
├── AGENTS.md              # Project rules, constraints, and architecture guidelines
├── PROJECT_SPEC.md        # Comprehensive technical specification
├── USER_PROFILE.md        # Career profile, domain matches, and targeting
└── package.json           # Node.js ESM configuration and scripts
```

> **On `supabase/functions/_shared/`**: this directory is generated by
> `npm run edge:sync` and is git-ignored. `src/` is the single source of truth.
> The Edge bundle cannot reach `../../src/` after deployment, because
> `supabase functions deploy` bundles each function directory independently, so
> the shared modules are mirrored into the documented `_shared` location.
> `npm test` runs the sync first, so the bundle is never stale when tested.
> Both keep the bare `@supabase/supabase-js` specifier, which Node resolves from
> `node_modules`; `supabase/functions/import_map.json` maps it to the `npm:`
> form the Edge bundler requires, and every deploy/serve command passes it via
> `--import-map`.

---

## Tech Stack & Constraints

- **Language**: Modern JavaScript (ES Modules only, `import`/`export`). **No TypeScript**.
- **Runtime**: Node.js LTS (v20+).
- **Backend / Database**: Supabase PostgreSQL (`@supabase/supabase-js`).
- **AI Classification**: Google Gemini API with structured output (`responseSchema`).
- **Compliance Rules**:
  - No authenticated LinkedIn scraping or browser automation (Playwright/Puppeteer/Selenium).
  - Operates purely on **public job posting URLs** from LinkedIn, Greenhouse, Ashby, and Lever indexed by external search engines.
  - Notifications go through the Resend Email API only (no unofficial clients, no
    browser automation against any chat service).

> **Note on the AI provider:** the classifier was originally specced against
> OpenAI and has since been ported to Gemini. `responseSchema` accepts a subset
> of OpenAPI 3.0, not full JSON Schema — a field is `type: 'string'` plus
> `nullable: true`, never `type: ['string', 'null']`, and `enum` values are
> strings only. Anything outside that subset is rejected by the API with
> HTTP 400 before the model is ever called. See `src/ai/classify.js`.

### Gemini Reliability and Cost Controls

Classification is configured entirely through `GEMINI_*` variables, so a free
tier can be kept economical without code changes. Defaults in parentheses:

| Variable | Purpose |
| --- | --- |
| `GEMINI_MODEL` | Model to call (`gemini-3.5-flash-lite`). |
| `GEMINI_CONCURRENCY` | Requests in flight at once (`1`). Retries share the same slot, so a retry never overlaps another request. |
| `GEMINI_MAX_RETRIES` | Retries after the first attempt (`2`), applied to 429/503/408/409/timeouts only. |
| `GEMINI_INITIAL_RETRY_DELAY_MS` | First backoff wait (`2000`), doubling per attempt with jitter. |
| `GEMINI_REQUEST_TIMEOUT_MS` | Per-attempt timeout (`30000`). |

Retry policy by HTTP status:

| Status | Behaviour |
| --- | --- |
| 401 (or 400 `API key not valid`) | `authentication_failed`, never retried. |
| 403 | `permission_denied`, never retried. |
| 404 | `model_unavailable`, never retried, names the model. |
| 429, quota exhausted | `quota_exhausted`, never retried. |
| 429, transient rate limit | Backoff with jitter, honors `Retry-After`/`retryDelay`. |
| 408, 409, 5xx, timeout | Backoff with jitter. |
| 400, other | `request_failed`, never retried. |

A run reports `Phase 5 Status: OPERATIONAL`, `PARTIAL`, or `FAILED` and a
reason. It is only `OPERATIONAL` when classification actually executed — a run
that classified nothing because Gemini was unavailable reports `FAILED` rather
than a clean bill of health.

---

## Getting Started

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v20.0.0 or higher)
- [npm](https://www.npmjs.com/) (v10.0.0 or higher)
- A [Supabase](https://supabase.com/) project

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd designRadar
npm install
```

### 3. Environment Configuration

Copy the template environment file:

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials:

```dotenv
# Supabase PostgreSQL
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# Google Gemini (classification)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_CONCURRENCY=1
GEMINI_MAX_RETRIES=2
GEMINI_INITIAL_RETRY_DELAY_MS=2000
GEMINI_REQUEST_TIMEOUT_MS=30000

# Search Provider
SEARCH_PROVIDER=serper
SEARCH_API_KEY=your-search-api-key

# Notification Provider ('ntfy' for production, 'mock' for local dev)
NOTIFICATION_PROVIDER=email
# Only true if a mock run should consume the real post queue. Default false.
NOTIFICATION_MARK_MOCK_SENT=false

# ntfy (required once NOTIFICATION_PROVIDER=ntfy)
RESEND_API_KEY=your-resend-api-key
DESIGN_RADAR_EMAIL_TO=recipient@example.com
DESIGN_RADAR_EMAIL_FROM=radar@example.com
# Optional; defaults to 15000ms when unset or invalid.
NOTIFICATION_TIMEOUT_MS=15000

# Configuration
TIMEZONE=Africa/Lagos
DAILY_DIGEST_HOUR=8
# High/standard priority threshold. Not a qualification gate: see .env.example.
MIN_RELEVANCE_SCORE=60
```

---

## Applying the Supabase Migration

Database migrations are located in `supabase/migrations/`.

### Option A: Using the Supabase Dashboard (Recommended for quick setup)

1. Open your Supabase project dashboard at [supabase.com](https://supabase.com/dashboard).
2. Navigate to **SQL Editor** in the left sidebar.
3. Open `supabase/migrations/001_initial_schema.sql` from this repository.
4. Copy and paste the contents into the SQL Editor and click **Run**.
5. Apply `supabase/migrations/003_notification_delivery.sql` as well — Phase 7
   records `error_type` on every notification, so delivery fails without it.
6. Apply `supabase/migrations/004_notification_provider_ntfy.sql` — it renames the
   legacy provider-specific `sent_*` column to `sent_to_digest`, which Phase 7
   reads to avoid re-sending a post that was already delivered.
6. Verify in the **Table Editor** that the following tables exist:
   - `search_runs`
   - `companies`
   - `recruiters`
   - `linkedin_posts`
   - `notifications`

### Option B: Using the Supabase CLI

```bash
# These files are numbered, not timestamp-prefixed, so apply them explicitly:
supabase db query --linked -f supabase/migrations/005_phase9_scheduling.sql

# See "Setting it up" for the full automated path:
npm run schedule:enable
```

---

## Running the Project

### Execute Radar Run

```bash
npm run radar
```

Full pipeline: scan → classify → score → persist → digest → deliver. With
`NOTIFICATION_PROVIDER=mock` the digest is printed and nothing is sent; with
`ntfy` it is published to your topic.

### Scan Only

Skips digest generation and delivery, so it stays a fast smoke test of the
Phase 5 pipeline:

```bash
npm run scan
```

### Digest Only

Builds the digest from the qualified, unread posts discovered within the lookback
window and delivers it through the configured provider. Falls back to mock posts
when Supabase is not configured — in which case nothing is recorded or marked,
because those posts do not exist in the database.

```bash
npm run digest
```

The lookback defaults to 168 hours (one week) and is configurable with
`DIGEST_LOOKBACK_HOURS`. A post found on an unlucky day therefore still reaches a
digest instead of being silently dropped. The separate 24-hour publication window
that earns a post the `VERIFIED` heading is fixed in code.

Every qualified post is delivered, whatever it scored. `MIN_RELEVANCE_SCORE` only
decides the `high`/`standard` priority band and the ordering inside the digest —
lowering it promotes weak matches, it does not admit posts that the eligibility
gate rejected.

### Sent State

Posts are marked as sent only after the provider confirmed delivery **and** the
notification row was written. Anything else — a failed or malformed response, a
rate limit, a missing credential, a duplicate digest, or a failed record — leaves
posts unmarked so the next run retries them. `NOTIFICATION_MARK_MOCK_SENT=true`
opts a mock run into consuming that queue; leave it off while developing.

Switching to real delivery means changing one line:

```dotenv
NOTIFICATION_PROVIDER=ntfy
```

No pipeline code changes: nothing outside `src/notifications/` knows which
provider is in use.

---

## Production Scheduling

### What gets scheduled

Notifications are **server-side**: Supabase Postgres cron calls the deployed
`daily-radar` Edge Function. Nothing runs on your machine, so a closed laptop
does not stop the digests.

Discovery and delivery deliberately share one schedule, because a new
opportunity is only useful if you hear about it. The 4-hour job runs mode
`full` — search, classify, score, persist, digest, deliver — and only genuinely
new posts are sent, so a quiet four hours produce no notification at all.

| Job | Cron | UTC | Local (Africa/Lagos) | Mode |
| --- | --- | --- | --- | --- |
| Discovery + immediate delivery | `0 */4 * * *` | 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 | 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 | `full` |
| Daily safety net | `0 7 * * *` | 07:00 daily | **08:00 daily** | `digest` |

The daily job exists only to re-deliver posts whose delivery failed; those stay
unsent because a post is marked sent only after ntfy confirms delivery. With the
4-hour job delivering, it normally has nothing left to send.

> **Supabase/Postgres cron schedules are configured in UTC.** Africa/Lagos is
> UTC+1, so the 08:00 Lagos daily job runs at 07:00 UTC. The database
> timezone is *not* configured to Africa/Lagos and does not need to be — the
> schedules above are simply written in UTC. Scheduling the digest at
> `0 8 * * *` would fire at 09:00 in Lagos.

### Execution modes

`runRadar()` takes a `mode`, which is the only difference between the two jobs.
Both modes run the same pipeline from the same modules — there is no separate
Edge-specific implementation.

```js
runRadar({ mode: 'discovery' })  // search → classify → score → persist. Never notifies.
runRadar({ mode: 'digest' })     // load stored posts → digest → deliver → mark sent. Never searches.
runRadar()                       // 'full': both. The default, unchanged for local use.
```

- **`discovery`** stops after persistence. Qualified posts stay in the queue for
  the next daily digest. It does not require a working notification provider, so
  an ntfy problem cannot block the 4-hour scan.
- **`digest`** performs no web searches. It loads already-qualified posts,
  renders the digest, delivers it, and only then marks the posts sent.
- **`full`** is the historical behaviour and the default, so `npm run radar` and
  `runRadar()` are unaffected. The legacy `runRadar({ digest: false })` still
  means scan-only.
- An unrecognised mode is **rejected**, never defaulted. A silent fallback to a
  notifying mode would deliver a digest the caller explicitly did not ask for.

### Setting it up

```bash
brew install supabase/tap/supabase   # one-time
supabase login                       # one-time: opens a browser, stores a token in your keychain
npm run schedule:enable              # everything below, in order
```

`schedule:enable` is idempotent — re-running replaces the deployment, the
secrets, and both cron jobs instead of adding duplicates. It performs:

1. `supabase link` against the project ref parsed from `SUPABASE_URL`
2. `supabase secrets set --env-file .env` — the Edge environment needs its own
   copies of the keys, because `.env` is not deployed with a function
3. `npm run edge:sync && supabase functions deploy --import-map supabase/functions/import_map.json`
4. stores the project URL and service-role key in **Supabase Vault** under
   `design_radar_supabase_url` / `design_radar_service_role_key`, so no secret is
   ever committed to SQL
5. applies `supabase/migrations/005_phase9_scheduling.sql`
6. prints the resulting `cron.job` rows

Steps 4 and 5 go through `supabase db query`, not `supabase db push`. This
repository's migrations are numbered (`001_initial_schema.sql`) rather than
timestamp-prefixed, which the CLI's migration tracker does not accept — and
re-running the early migrations against a database that already has data is not
something to do by accident.

`ALTER DATABASE ... SET` is deliberately **not** used: Supabase hosted
Postgres does not allow it. Vault is the supported place for this.

**Docker is not required for any of this.** `functions deploy` and `db query`
both use the Management API. Docker is only needed for `supabase functions
serve`
and `db pull` / `db diff`.

<details>
<summary>Manual equivalent, if you prefer to run each step yourself</summary>

**1. Configure the Edge Function secrets.** These are the same variable names as
the CLI, but they live in the Supabase Edge environment — `.env` is not deployed
with a function, so a variable set only there is unset in production.

```bash
supabase secrets set \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  SEARCH_PROVIDER=serper \
  SEARCH_API_KEY=<serper-key> \
  GEMINI_API_KEY=<gemini-key> \
  GEMINI_MODEL=gemini-3.5-flash-lite \
  NOTIFICATION_PROVIDER=ntfy \
  NTFY_BASE_URL=https://ntfy.sh \
  NTFY_TOPIC=<topic>
```

Discovery needs everything except the ntfy variables. Digest needs Supabase and
ntfy, and never touches the search or Gemini keys. Never commit these values.

**2. Let the cron job authenticate itself.** The migration reads the service
role key and project URL from **Supabase Vault** rather than embedding them in
SQL. Run these once in the SQL Editor — they are not committed:

```sql
create extension if not exists supabase_vault with schema vault;

select vault.create_secret(
  'https://<project-ref>.supabase.co',
  'design_radar_supabase_url',
  'DesignRadar Supabase project URL'
);
select vault.create_secret(
  '<service-role-key>',
  'design_radar_service_role_key',
  'DesignRadar service role key'
);
```

If a secret already exists, `vault.create_secret` will not replace it — use
`vault.update_secret(<id>, ...)`, or just re-run `npm run schedule:enable`,
which handles both cases.

Until these are set, each job raises an exception naming the missing secret —
visible in `cron.job_run_details` — rather than failing silently.

**3. Apply the migration and deploy.**

```bash
npm run edge:deploy                                   # syncs the shared sources, then deploys
supabase db query --linked -f supabase/migrations/005_phase9_scheduling.sql
```

The migration is re-runnable: it unschedules both jobs before recreating them,
so a corrected schedule replaces the old one instead of adding a duplicate.

**4. Verify.**

```sql
-- the two jobs exist and are active
select jobid, jobname, schedule, active from cron.job
 where jobname like 'design-radar-%';

-- every cron invocation (the DO block; note: no `jobname` column)
select jobid, status, start_time, return_message
  from cron.job_run_details order by start_time desc limit 5;

-- the HTTP outcome of each invocation, including status and body
select id, status_code, timed_out, left(content, 200), created
  from net._http_response order by created desc limit 5;

-- what has actually been delivered
select provider, status, count(*), max(sent_at)
  from notifications group by 1, 2;
```

`net.http_post` is called with `timeout_milliseconds := 120000` because pg_net's
5000 ms default is shorter than a `full` run; without it every scheduled
invocation records `timed_out = true` and no body to inspect.

### Invoking it by hand

```bash
# Discovery + immediate delivery (what the 4-hour cron job runs)
curl -X POST "$SUPABASE_URL/functions/v1/daily-radar" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"full"}'

# Discovery only, no notification
curl -X POST "$SUPABASE_URL/functions/v1/daily-radar" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"discovery"}'

# Daily digest of whatever is still unsent
curl -X POST "$SUPABASE_URL/functions/v1/daily-radar" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"digest"}'
```

```json
{
  "success": true,
  "mode": "discovery",
  "status": "OPERATIONAL",
  "statistics": {
    "queriesRun": 3,
    "searchResults": 10,
    "uniqueResults": 8,
    "candidates": 6,
    "classified": 5,
    "qualified": 4,
    "notificationSent": false
  }
}
```

Every statistic is read from the `runRadar()` summary rather than recomputed. A
statistic the run did not produce is reported as `null`, not `0`, so a missing
value stays visible instead of looking like a real count.

**`mode` is optional.** When the body is absent or omits `mode`, the function
defaults to **`discovery`**. The safe default is deliberate: an unqualified
request — a health check, a manual test hit, a misconfigured cron job — must
never consume the daily notification.

Errors return `{"success": false, "error": "..."}`. Messages are redacted
against the configured secret values and against token-shaped strings, and a
stack trace is logged server-side but never returned.

## Email Notifications (Resend)

[Resend](https://resend.com/) is a developer-first email platform. DesignRadar uses it to deliver the daily digest as a clean, formatted HTML email.

### Setup

1. **Sign up at Resend.** Create an account and verify your sending domain.
2. **Configure it.** Add your API key and addresses to :

   

3. **Verify delivery** before trusting a run:

   

### Local development

```dotenv
NOTIFICATION_PROVIDER=mock
```

`mock` prints the digest, sends nothing, and leaves every post unmarked.

### Run Tests

Runs all unit tests with Node's native test runner (zero external test
dependencies, no network or credentials required):

```bash
npm test
```

### Run Linter / Syntax Check

Parses every source and test file:

```bash
npm run lint
```

### Isolated Multi-Source Smoke Test

Runs the real orchestrator (`runRadar`) in `discovery` mode end-to-end — query
generation → search → normalization → dedup → keyword filter → classification →
scoring → persistence — with every external boundary faked in-process:

```bash
npm run smoke:multi-source
```

It uses fixtures covering all four sources (LinkedIn, Greenhouse, Ashby, Lever),
tracking-parameter duplicates, a stale post, a non-design hiring post, and an
unlevelled title. The search provider, the Gemini classifier, and the database
are injected; `globalThis.fetch` is replaced with a thrower for the run, so a
live HTTP call fails the script instead of sneaking through. No credentials,
network, Supabase project, or notification provider are touched, and nothing is
persisted. Exits non-zero if any check fails.

---

## Development Phases

- [x] **Phase 1**: Project foundation + database
- [x] **Phase 2**: Search provider + discovery
- [x] **Phase 3**: Normalization + deduplication + keyword filtering
- [x] **Phase 4**: AI classification (Gemini structured JSON)
- [x] **Phase 5**: Deterministic relevance scoring + recency status
- [x] **Phase 6**: Digest generation & chunking (mock notification prints only)
- [x] **Phase 7**: Notification delivery (provider abstraction, mock + ntfy)
- [x] **Phase 8**: Radar orchestrator (`runRadar()`) with injectable dependencies
- [x] **Phase 9**: Supabase Edge Function + UTC cron scheduling (discovery + digest modes)
- [x] **Phase 10**: Email Notification Delivery
- [ ] **Phase 11**: Optimization

### Known Gaps

- **The ntfy topic is open.** `NTFY_TOKEN` is empty, so delivery works but
  anyone who learns `NTFY_TOPIC` can read or post to it. Set a token
  (`Authorization: Bearer ...` on ntfy.sh, or a self-hosted server with auth)
  and run `npm run notify:test` again to confirm it still delivers.
- **No retry scheduling.** Delivery failures leave posts unmarked and are
  retried on the next run; `retryAfterMs` is carried on the result but nothing
  consumes it yet. A failed digest is picked up by the next scheduled job, which
  is at most four hours later. The one failure recorded so far
  (2026-10-06 08:00 UTC, `Buffer is not defined`) was an Edge-runtime bug in
  `src/notifications/ntfy.js`, fixed and redeployed the same day.
- **The schedule is live; one scheduled delivery is still unobserved.** Both
  jobs fired on 2026-10-06, and a pg_cron invocation has since been proven to
  return HTTP 200 with `timed_out = false`. What remains is watching a
  scheduled run that actually finds new posts and delivers them — check the
  SQL under “Verify” after the next 4-hourly run.
- **`supabase/functions/_shared/` is a generated copy of `src/`.** Deployments
  depend on the sync step running; `npm run edge:deploy` and `npm test` both do
  it, and `npm run edge:check` fails if it is stale. Editing the copy directly
  would be overwritten and would diverge from the CLI.
- **`src/index.js` has partial test coverage.** `derivePipelineStatus` is
  covered in `test/run-status.test.js`; the orchestrator itself is exercised by
  `test/radar-orchestrator.test.js` and `test/radar-modes.test.js`.
- **Greenhouse/Ashby/Lever coverage is search-index driven.** Discovery searches
  Google (via Serper) for postings indexed on each domain; it does not call the
  boards' public APIs. An unindexed posting is not found. The same job advertised
  on two platforms is kept as two rows — deduplication is by canonical URL, not
  by title similarity.

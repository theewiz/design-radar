# AGENTS.md

## Project

Project name: DesignRadar

DesignRadar is a personal job-intelligence application that discovers publicly
discoverable Senior+ Product Design opportunities from four sources — LinkedIn
posts and Greenhouse, Ashby, and Lever job boards — classifies them with AI,
scores them for relevance, stores them in Supabase, and sends a daily digest
through the configured notification provider (Resend email in production; ntfy
is also supported).

The application is intended for personal job discovery.

---

## Core Technical Requirements

### Language

Use JavaScript only.

DO NOT use TypeScript.

Use modern JavaScript:

- ES modules
- async/await
- fetch
- destructuring
- optional chaining where appropriate
- named exports/imports

Do not introduce TypeScript files.

---

### Runtime

Use Node.js.

The project should remain compatible with current LTS Node.js releases.

Use npm.

---

### Backend

Primary backend/database:

Supabase PostgreSQL.

Use:

- @supabase/supabase-js
- Supabase Edge Functions where appropriate
- Supabase Cron for scheduled execution

Do not introduce another database unless explicitly requested.

---

### AI

Use the Google Gemini API for classification and structured extraction.

The AI must return structured JSON.

Do not rely on free-form natural-language model output for fields that need
to be stored in the database.

Validate all AI-generated structured data before inserting it into Supabase.

`responseSchema` accepts a subset of OpenAPI 3.0, not full JSON Schema. Keep
`src/ai/classify.js` inside that subset: one string `type` per field,
`nullable: true` for optionals, string-only `enum` values, and no
`additionalProperties` or numeric bounds. Anything outside the subset is
rejected with HTTP 400 before the model runs, so `src/ai/classify.js` must not
be edited without a live API check or a test asserting the schema shape.

Never hard-code the model name, concurrency, retry count, or delay. Resolve
them from `GEMINI_*` environment variables at call time.

Retries must stay status-aware and cheap:

    401 / invalid key  → permanent, never retried
    403                → permanent, never retried
    404                → permanent, never retried, name the model
    429 quota exhausted → permanent, never retried
    429 transient      → exponential backoff with jitter
    408 / 409 / 5xx / timeout → exponential backoff with jitter

Backoff requires jitter. Without it, every candidate in a batch wakes at the
same instant and reproduces the burst that tripped the rate limit in the first
place.

Verify the live API, not just the mock. The Gemini endpoint reports an invalid
key as HTTP 400 with `INVALID_ARGUMENT`, not 401, so matching on status alone
misclassifies an authentication failure as an unexplained request error.

---

### Search / Discovery

The system must NOT:

- log into LinkedIn
- automate a LinkedIn browser session
- use Puppeteer/Playwright/Selenium to crawl LinkedIn
- scroll a LinkedIn feed programmatically
- scrape authenticated LinkedIn pages
- bypass LinkedIn access controls
- attempt to evade anti-bot systems

The discovery layer should operate on publicly discoverable job posting URLs
returned by an external search/indexing provider. Four sources are supported,
each with its own canonical URL pattern:

- LinkedIn posts — `linkedin.com/posts/`
- Greenhouse job boards — `boards.greenhouse.io`, `job-boards.greenhouse.io`
- Ashby job boards — `jobs.ashbyhq.com`
- Lever job boards — `jobs.lever.co`

The search provider must be abstracted behind a provider interface so it can
be replaced later. Source-specific queries are generated in
`src/search/queries.js` (`generateMultiSourceSearchQueries`) from a shared role /
hiring / domain term list, with LinkedIn receiving the largest share of the
query budget and the other sources sharing the remainder. A new source or query
lane is added there, never by editing a provider adapter.

Example:

searchWeb(query)

Do not tightly couple the application to one search provider.

---

### Notification (Resend)

Use the Resend HTTP API (`POST https://api.resend.com/emails`, body is the digest).

Do not implement unofficial chat or push clients.
Do not introduce heavy HTML templating libraries or full-blown SDKs unless necessary.

The notification layer is abstracted.

Example:

notifier.send(message)

This allows the provider to be replaced by another notification provider later.

---

### Architecture

Maintain clear separation between:

1. Discovery
2. Normalization
3. Deduplication
4. Filtering
5. AI classification
6. Relevance scoring
7. Database persistence
8. Digest generation
9. Notification

Do not put the entire application in one file.

---

### Data Integrity

Never invent:

- recruiter names
- company names
- job titles
- locations
- application URLs
- posting dates

If information is unavailable, store null or "Unknown".

AI should explicitly distinguish between:

- information present in the source
- information inferred with high confidence
- information unavailable

Prefer null over hallucination.

---

### Job URLs

Normalize job posting URLs before storing them (`src/utils/normalize-url.js`).
Each source has a deterministic normalizer; `normalizeJobUrl` dispatches on the
URL's host and path.

Remove:

- query parameters (e.g. `gh_jid`, `utm_*`, `lever-source`)
- fragments
- unnecessary trailing slashes

Use the normalized URL as the primary deduplication key. The same underlying job
posted on two platforms keeps two distinct canonical URLs and is intentionally
not merged on title similarity alone.

---

### Job Relevance

The primary target is:

- Senior Product Designer
- Lead Product Designer
- Staff Product Designer
- Principal Product Designer
- Senior UX/Product Designer
- Product Design Lead
- Design Lead
- Founding Product Designer
- Founding Designer
- Head of Product Design

The system should generally exclude:

- Junior Designer
- Intern
- Graphic Designer
- Visual Designer
- Brand Designer
- Marketing Designer
- Motion Designer
- Industrial Designer
- Interior Designer
- Fashion Designer

Unless the role clearly includes substantial Product Design responsibilities.

### Profile Role Policy

Search terms, the seniority a post advertises, and the seniority this profile
wants are three different things. They are reconciled in one place,
`src/profile/role-policy.js`, and nothing else may re-decide them:

- `Mid`, and `Unknown` on an unlevelled title (`Product Designer`,
  `UX Designer`, `UX/UI Designer`), resolve to `Senior` for scoring *and*
  persistence. The model still reports what the text says; the elevation is a
  deterministic application policy applied after classification.
- `Junior` is never elevated and fails the eligibility gate, so it is stored as
  `irrelevant`.
- Unlevelled product design titles are exempt from the confidence gate.

Do not move these rules into the classification prompt, and do not re-implement
them in `score.js`, `status.js`, or the orchestrator. They are documented in
PROJECT_SPEC §13, §11, and §16.

---

### User Profile

The system should optimize for opportunities relevant to a Senior Product
Designer with experience in:

- fintech
- financial infrastructure
- payments
- AI
- B2B SaaS
- compliance
- RegTech
- Web3
- blockchain
- digital assets
- design systems
- complex data-heavy products
- enterprise software
- ai design tools
- design tools for developers

Preferred working arrangements:

- fully remote
- remote-first
- global
- EMEA
- Europe
- UK
- US
- worldwide

Do not automatically reject a post when location is unknown.

---

### Code Quality

Prioritize:

- readable code
- small modules
- explicit function names
- error handling
- input validation
- useful logs
- testability
- environment-based configuration

Avoid:

- unnecessary abstractions
- premature frameworks
- massive dependencies
- duplicated logic
- hardcoded secrets

---

### Secrets

Never hardcode secrets.

Use environment variables.

Expected environment variables may include:

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
GEMINI_MODEL
SEARCH_API_KEY
NOTIFICATION_PROVIDER
RESEND_API_KEY
DESIGN_RADAR_EMAIL_TO
DESIGN_RADAR_EMAIL_FROM
NTFY_BASE_URL
NTFY_TOPIC
NTFY_TOKEN

Create `.env.example`.

Never commit `.env`.

---

### Database

Database changes must be represented as SQL migrations.

Do not manually create undocumented database structures.

All tables and indexes should be represented in:

supabase/migrations/

---

### Logging

Log important execution information:

- run started
- query count
- search results count
- unique URLs
- candidate count
- AI classification count
- qualified count
- saved count
- notification count
- errors

Do not log secrets or full access tokens.

---

### Error Handling

External API calls must:

- handle non-2xx responses
- provide useful errors
- retry transient failures where appropriate
- avoid infinite retries

If one search query fails, do not necessarily abort the entire run.

If notification fails, do not mark posts as sent.

---

### Testing

Before considering a feature complete:

1. Run the application.
2. Run available tests.
3. Test malformed input.
4. Test duplicate LinkedIn URLs.
5. Test irrelevant jobs.
6. Test missing recruiter names.
7. Test missing company names.
8. Test missing timestamps.
9. Test external API failure handling.

---

### Development Strategy

Build incrementally.

Do not implement the entire production system in one step.

Use these phases:

Phase 1:
Project foundation + database

Phase 2:
Search provider + discovery

Phase 3:
Normalization + deduplication

Phase 4:
AI classification

Phase 5:
Relevance scoring

Phase 6:
Digest generation

Phase 7:
Notification provider

Phase 8:
Supabase Edge Function + Cron

Phase 9:
Testing + observability

Phase 10:
Optimization

Complete and test one phase before moving to the next.

---

### Important Agent Behavior

Before changing architecture:

- inspect existing files
- understand the current implementation
- reuse existing utilities
- avoid unnecessary rewrites

When touching Edge Function deployment:

- keep `src/` on the bare `@supabase/supabase-js` specifier — Node and the test
  suite resolve it from `node_modules` and reject the `npm:` scheme
- pass `--import-map supabase/functions/import_map.json` to every
  `supabase functions deploy` / `functions serve`; it maps the bare specifier
  to the `npm:` form the Edge bundler requires
- never edit `supabase/functions/_shared/` directly; it is generated by
  `npm run edge:sync` from `src/`

When touching scheduling or migrations:

- cron credentials live in **Supabase Vault**, not `ALTER DATABASE` /
  `app.settings` (Supabase hosted Postgres does not allow it)
- migrations are numbered, not timestamped, so `supabase db push` does not
  accept them — apply with `supabase db query --linked -f <file>`, and never
  re-run 001–004 against a database that already has data
- `net.http_post` in `005_phase9_scheduling.sql` must keep an explicit
  `timeout_milliseconds` of at least 60000; the 5000 ms default is shorter than
  a `full` run, which hides the HTTP outcome of every scheduled invocation


When requirements are ambiguous:

- choose the simplest implementation consistent with this specification
- document the decision
- do not introduce unnecessary dependencies

After implementing a feature:

- run the relevant tests
- run linting if configured
- verify imports
- verify environment variables
- report what changed

Do not claim something works unless it was actually tested.

---

### UI

The initial MVP does NOT require a web dashboard.

The first usable interface is the daily digest.

Do not build a frontend unless explicitly requested.

---

### Primary Success Criterion

The system should eventually be able to:

discover → classify → score → deduplicate → store → notify

a useful set of Senior+ Product Design opportunities discovered from publicly
available LinkedIn post search results.

The system should prioritize signal quality over the raw number of jobs found.

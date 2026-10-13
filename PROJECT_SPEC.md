# DesignRadar — Project Specification

Version: 1.0

Status: MVP

---

# 1. Product Overview

DesignRadar is a personal job-intelligence system for discovering Senior+
Product Design opportunities posted publicly on LinkedIn.

The system searches public web indexes for LinkedIn posts, identifies
recruiter/hiring posts, classifies them using AI, scores them according to
the user's career profile, stores qualified opportunities in Supabase, and
generates a daily digest.

The system should eventually deliver this digest via Email (Resend).

---

# 2. Primary User

The primary user is a Senior Product Designer looking for fully remote
opportunities.

The user's relevant experience includes:

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
- developer tools / design tools for developers
- AI design tools
- enterprise software
- design systems
- complex data-heavy products

The system should prioritize these areas.

---

# 3. Primary User Goal

The user wants to receive a daily list of relevant LinkedIn recruiter posts
without manually searching LinkedIn.

The desired output is:

Recruiter name
Company
Role
Location
Remote status
Approximate posting time
Short description
LinkedIn post URL
Application URL if available

---

# 4. Core Workflow

The complete system:

CRON
↓
Generate search queries (budgeted 5–8 queries, rotated by domain)
↓
Search public web index (via abstracted provider adapter)
↓
Collect LinkedIn URLs
↓
Normalize URLs (§8)
↓
Deduplicate (primary DB URL check + in-run fingerprint §9)
↓
Cheap keyword filtering (with Seniority Title bypass §10)
↓
AI classification (structured JSON with confidence & recruiter flag §11)
↓
Relevance scoring (deterministic, Head supported, clamped 0..100 §14)
↓
Persist all evaluated posts in Supabase (status: qualified, stale, irrelevant, low_confidence §17)
↓
Generate daily digest (chunked for a 4096-char provider limit, grouping verified vs recent §20)
↓
Send notification (atomic per chunk §22)
↓
Record notification state (is_notified = true, notified_at = now())

---

# 5. Discovery

The discovery system must NOT directly crawl LinkedIn or any job board.

It must search for publicly discoverable job posting URLs using a
search/indexing provider. Supported sources:

1. **LinkedIn** — posts at `linkedin.com/posts/`
2. **Greenhouse** — job boards at `boards.greenhouse.io` and `job-boards.greenhouse.io`
3. **Ashby** — job boards at `jobs.ashbyhq.com`
4. **Lever** — job boards at `jobs.lever.co`

The provider must be abstracted.

Interface:

```javascript
export async function searchWeb(query, options = {}) {
  // return normalized search results
}

// options parameter shape:
// {
//   limit?: number,      // default: 10, max: 50
//   timeRange?: string   // 'd' (day), 'w' (week), 'm' (month), default: 'd'
// }
```

Return format:

```javascript
{
  url,
  title,
  snippet,
  publishedAt,
  source   // 'linkedin', 'greenhouse', 'ashby', or 'lever'
}
```

---

## 5.1. Multi-Source URL Normalization

Each source has its own URL pattern and normalization rules:

### LinkedIn Posts
- Patterns: `/posts/{slug}`, `/feed/update/urn:li:activity:{id}`, `/pulse/{slug}`
- Normalization: strip query params, fragments, trailing slashes; enforce `https://www.linkedin.com`

### Greenhouse Job Boards
- Domains: `boards.greenhouse.io`, `job-boards.greenhouse.io`
- Pattern: `/{company}/jobs/{id}`
- Normalization: strip query params (`gh_jid`, `utm_*`), fragments, trailing slashes

### Ashby Job Boards
- Domain: `jobs.ashbyhq.com`
- Pattern: `/{company}/{job-id}`
- Normalization: strip query params (`utm_*`), fragments, trailing slashes

### Lever Job Boards
- Domain: `jobs.lever.co`
- Pattern: `/{company}/{job-id}`
- Normalization: strip query params (`lever-origin`, `lever-source`, `utm_*`), fragments, trailing slashes

All normalized URLs use the canonical domain and HTTPS. The normalized URL serves as the primary deduplication key across all sources.

---

## 6. Search Query Strategy

Search queries should combine three categories:

### Role Terms

* "Senior Product Designer"
* "Lead Product Designer"
* "Staff Product Designer"
* "Principal Product Designer"
* "Senior UX Designer"
* "Product Design Lead"
* "Design Lead"
* "Founding Product Designer"
* "Founding Designer"
* "Head of Product Design"
* "Product Designer"

The final term is deliberately **unlevelled**. Many employers that hire for
this profile publish the vacancy under a flat title — at a fintech, crypto, or
AI tooling company, "Product Designer" is routinely a senior individual-
contributor seat — and the exact phrase `"Senior Product Designer"` cannot
retrieve those posts at all. It is therefore queried as its own lane on every
run, not merely listed as a synonym.

This widens discovery, not the quality bar:

* Seniority is still read from the classified post text, never from the search
  term that retrieved it (§12 rule 3). What happens afterwards is §13's Profile
  Role Policy: `Mid`, and `Unknown` on an unlevelled product design title,
  resolve to `Senior` before scoring, so a post titled only "Product Designer"
  is scored as a senior vacancy rather than skipped. The elevation keys off the
  classifier's own fields — it is never inferred from the query lane.
* A post titled only "Product Designer" is classified `Mid` or `Unknown` by the
  model; §13 then resolves it for scoring and storage. It is not discarded.
* §16 exclusion still applies, so "Product Designer" retrieves junior,
  graphic, brand, and marketing posts too. Those are removed by §10 keyword
  filtering and §14 rule 1 (and `Junior` fails the eligibility gate outright),
  at the cost of the AI calls they consume.

### Hiring Signals

* "hiring"
* "we're hiring"
* "we are hiring"
* "looking for"
* "open role"
* "open position"
* "join our team"
* "my team is hiring"
* "recruiting"

### Domain Terms

Where useful, queries may also include:

* fintech
* finance
* AI
* payments
* financial infrastructure
* compliance
* RegTech
* Web3
* blockchain
* SaaS
* digital assets
* crypto
* developer tools
* enterprise software

### Query Representation and Provider Independence

Search queries are generated as provider-agnostic query objects with a target domain:

```javascript
{
  terms: ["Senior Product Designer", "fintech", "hiring"],
  targetDomain: "linkedin.com/posts/",
  source: "linkedin"
}
```

Supported target domains:
* `linkedin.com/posts/` (source: "linkedin")
* `boards.greenhouse.io` (source: "greenhouse")
* `job-boards.greenhouse.io` (source: "greenhouse")
* `jobs.ashbyhq.com` (source: "ashby")
* `jobs.lever.co` (source: "lever")

The active search provider adapter formats this into its native syntax:
* **Serper / Google / Brave adapter**: `site:{targetDomain} "Senior Product Designer" fintech hiring`
* **Tavily adapter**: `query: "Senior Product Designer fintech hiring", include_domains: ["{targetDomain}"]`

### Query Budget and Rotation Strategy (Multi-Source)

To avoid combinatorial explosion and conserve search API quotas, each execution
generates an explicit budget of **6 to 10 high-yield queries** (`queryBudget`,
default 8) distributed across all configured sources:

**Budget allocation:**
- **LinkedIn** (primary source): ~50% of budget, minimum 3 queries
- **Greenhouse, Ashby, Lever** (additional sources): share remaining ~50%, minimum 1 query each when budget allows
- For small budgets (≤4): LinkedIn gets `budget - 1` queries, one other source gets 1 query

**Per-source query composition (same for all sources):**
1. **2 Core Seniority queries**: `["Senior Product Designer", "hiring"]`, `["Lead Product Designer", "we're hiring"]`
2. **1 Remote-specific query**: `["Senior Product Designer", "remote", "hiring"]`
3. **1 Broad unlevelled-title query**: `["Product Designer", "hiring"]` — skipped if a core query already uses this title
4. **Domain queries** filling remaining budget: rotating through the canonical domain list across runs

Running 6 times daily yields ~36–60 total queries/day across all sources, well within standard entry-level tiers.

---

## 7. Search Result Normalization

Every search provider result must be converted into the following internal format:

```javascript
{
  url: string,
  title: string | null,
  snippet: string | null,
  publishedAt: string | null,
  source: string
}
```

Provider-specific response formats must not leak into the rest of the application.

Each search provider must have its own adapter.

### Search Snippets as Candidate Text

In strict compliance with LinkedIn access rules and anti-scraping constraints, DesignRadar relies on the public `title` and `snippet` returned by the external search provider. In database records and AI classification, `post_text` defaults to this search snippet. The pipeline must operate gracefully on snippet-length texts without expecting full webpage content.

Example:

```text
Search Provider
      ↓
Provider Adapter
      ↓
Normalized Search Result
      ↓
DesignRadar Pipeline
```

---

## 8. Job URL Normalization

Only recognized job posting URLs from supported sources should enter the post-processing pipeline.

Supported sources and their patterns:

### LinkedIn Posts
- Patterns: `/posts/{slug}`, `/feed/update/urn:li:activity:{id}`, `/pulse/{slug}`
- Example input: `https://www.linkedin.com/posts/example-123?trk=public_profile`
- Normalized: `https://www.linkedin.com/posts/example-123`

### Greenhouse Job Boards
- Domains: `boards.greenhouse.io`, `job-boards.greenhouse.io`
- Pattern: `/{company}/jobs/{id}`
- Example input: `https://boards.greenhouse.io/exampleco/jobs/1234567?gh_jid=1234567#detail`
- Normalized: `https://boards.greenhouse.io/exampleco/jobs/1234567`

### Ashby Job Boards
- Domain: `jobs.ashbyhq.com`
- Pattern: `/{company}/{job-id}`
- Example input: `https://jobs.ashbyhq.com/exampleco/abc123-def456?utm_source=linkedin`
- Normalized: `https://jobs.ashbyhq.com/exampleco/abc123-def456`

### Lever Job Boards
- Domain: `jobs.lever.co`
- Pattern: `/{company}/{job-id}`
- Example input: `https://jobs.lever.co/exampleco/abc123-def456?lever-origin=applied&lever-source=linkedin`
- Normalized: `https://jobs.lever.co/exampleco/abc123-def456`

**Normalization rules (all sources):**
- Remove all query parameters
- Remove URL fragments
- Remove unnecessary trailing slashes
- Normalize protocol to HTTPS
- Normalize hostname to canonical form

The normalization function must be deterministic per source.

The system rejects URLs that are not recognized job posting URLs from supported sources.

---

## 9. Deduplication

### Primary Deduplication Key

The normalized canonical job URL (`job_url` — stored in `linkedin_url` column for backward compatibility).
All stored opportunities must possess a valid, normalized job posting URL from a supported source. This is enforced as a `UNIQUE` constraint at the database layer and checked against existing database records *before* keyword filtering or AI classification. If a job URL is already in Supabase, it is skipped immediately.

The column name `linkedin_url` is retained for backward compatibility but now stores the canonical URL from any supported source (LinkedIn, Greenhouse, Ashby, Lever).

### Secondary In-Run Fingerprint

Within a single search execution across multiple query variations and sources, duplicate announcements may be published under differing URL tracking variations or redirects.

To prevent redundant AI classification costs during a run, compute an in-memory SHA-256 fingerprint:

```javascript
const inRunFingerprint = sha256(normalizeText(title + ' ' + snippet));
```

If an incoming candidate from the same search run matches an already processed candidate fingerprint, discard it before invoking AI.

Deduplication happens:

1. **Primary**: By normalized canonical job URL against Supabase (prevents re-evaluating existing posts).
2. **In-Run**: By `inRunFingerprint` across query batches in the same run (prevents duplicate AI spend).

---

## 10. Candidate Filtering

Before sending a search result to the AI classifier, perform inexpensive keyword filtering.

A candidate passes cheap filtering if it meets **Condition A** OR **Condition B**:

### Condition A: Product Design Term AND Hiring Term

**At least one Product Design term**:
* product designer
* product design
* UX designer
* UX/Product
* design lead

AND

**At least one Hiring term**:
* hiring
* we're hiring
* we are hiring
* looking for
* open role
* open position
* join our team
* my team is hiring
* recruiting

### Condition B: Seniority Title Bypass

If the title or snippet explicitly matches a target Senior+ Product Design role:
* "Senior Product Designer"
* "Lead Product Designer"
* "Staff Product Designer"
* "Principal Product Designer"
* "Founding Product Designer"
* "Founding Designer"
* "Head of Product Design"

Then it passes through to AI evaluation even if an explicit hiring verb was truncated in the search snippet. This prevents snippet truncation from discarding high-signal opportunities.

This is a cost-control gate. AI remains the final classifier.

---

## 11. AI Classification

Use the Google Gemini API to classify candidate posts. The response
schema must stay inside the OpenAPI 3.0 subset Gemini accepts (single
string `type` per field, `nullable: true` for optionals, string-only `enum`,
no `additionalProperties`); anything else is rejected with HTTP 400.

The classifier should determine:

- Is this actually a recruiting post?
- Is the role related to Product Design?
- What is the job title?
- What is the seniority?
- Who authored the post?
- What company is involved?
- What location is mentioned?
- Is the role remote?
- Is an application URL present?
- How confident is the classification?
- Why was the post classified this way?

Expected response:

```json
{
  "is_recruiting_post": true,
  "is_product_design_role": true,
  "job_title": "Senior Product Designer",
  "seniority": "Senior",
  "company_name": "Example",
  "author_name": "Jane Doe",
  "is_hiring_manager_or_recruiter": true,
  "location": "Remote / Europe",
  "remote_status": "Remote",
  "application_url": null,
  "confidence": 0.94,
  "reason": "The author is recruiting for a Senior Product Designer role and explicitly describes the position as remote."
}
```

The application must validate the AI response before using it.

Invalid or malformed responses should be retried when appropriate.

### Confidence Threshold Gate

The AI classifier returns a `confidence` score (0.0 to 1.0).
* Posts with `confidence >= 0.70` proceed to standard scoring and potential qualification.
* Posts with `confidence < 0.70` are stored in Supabase with `status = 'low_confidence'` and excluded from digests.

#### Confidence Exemption (profile rule)

Unlevelled product design titles — `product designer`, `ux designer`,
`ux/ui designer`, including senior-prefixed variants such as
"Senior Product Designer" — are **exempt** from the 0.70 gate.

A flat-titled post produces the thinnest available snippet, so its confidence is
lowest precisely when the role itself is unambiguous: a real vacancy titled
"Product Designer" routinely lands at 0.65–0.69 and was being discarded
without ever reaching a digest. The exemption stops the gate from suppressing
an opportunity the profile is deliberately searching for.

Constraints on the exemption:

* It applies **only** to the confidence gate. It never overrides the §14 rule 1
  eligibility gate, so a post the classifier rejected as non-recruiting or
  non-product-design is still `irrelevant`.
* It applies to the post's `job_title`, not to free snippet text, so a
  non-product-design post cannot buy exemption by mentioning the phrase.
* Every other title keeps the 0.70 gate. Titles such as "Head of Product
  Design" or "Founding Designer" still require the threshold.

---

## 12. AI Safety and Data Integrity Rules

The AI classifier must never fabricate missing information.

If a field cannot be established from the available information, return:

```json
{
  "company_name": null
}
```

Do not generate a plausible company name.

Do not infer recruiter identity from a company name.

Do not infer posting date from search-result ordering.

Do not infer remote status merely because the job description is short or because the company is known to hire remotely.

Do not infer an application URL.

Do not infer a location that is not supported by the source content.

Unknown values should remain `null` or `"Unknown"` depending on the field schema.

---

## 13. Seniority

Valid seniority values:

```text
Junior
Mid
Senior
Lead
Staff
Principal
Founding
Head
Unknown
```

### Target Seniority

DesignRadar should prioritize:

- Senior
- Lead
- Staff
- Principal
- Founding
- Head

Junior roles are excluded outright (§16). Mid roles are retained — see below.

### Profile Role Policy

The level a post advertises and the level this profile searches for are not the
same thing, so seniority is resolved **after** classification by
`src/profile/role-policy.js`, deterministically and testably.

The model still reports only what the text says. `resolveProfileSeniority` then
applies three rules:

| Condition | Result |
| :--- | :--- |
| `seniority` is `Senior`, `Lead`, `Staff`, `Principal`, `Founding`, or `Head` | unchanged |
| `seniority` is `Mid`, and `is_product_design_role` is true | `Senior` |
| `seniority` is `Unknown` and `job_title` contains `product designer`, `ux designer`, or `ux/ui designer` | `Senior` |
| `seniority` is `Unknown` and the title is anything else | unchanged (`Unknown`) |
| `seniority` is `Junior` | unchanged, and excluded by §14 rule 1 |
| `is_product_design_role` is not true | unchanged |

The resolved classification is what gets **scored and stored**, so
`linkedin_posts.seniority` and `relevance_score` always agree. The model's
original answer is still recoverable: the input object is never mutated.

Two consequences worth stating plainly:

* **Mid is counted as Senior.** A genuinely mid-level vacancy will therefore be
  over-scored by 30 points and can reach `high` priority. That is the accepted
  trade-off: in this profile's sectors, flat titles routinely describe senior
  seats, and a mid-level miss is cheaper than a senior vacancy the search never
  retrieved.
* **Title matching is a phrase test, not a seniority parser.** It does not read
  "Associate" or "Junior" out of a title. The one level guard is
  `seniority === 'Junior'`, read from the classifier's own field.

This is not a relaxation of §12 rule 3 ("never infer seniority"), which governs
the model. The model still answers `Unknown`; the elevation is an application
policy, applied where the score is computed.

---

## 14. Relevance Scoring

Relevance scoring is deterministic and computed in application code.

The final score must not be generated solely by the LLM.

### Scoring Signals

| Signal | Points |
| :--- | ---: |
| Head / Staff / Principal / Lead / Senior | +30 |
| Founding | +28 |
| Explicit hiring language | +20 |
| Recruiter / Hiring Manager identified (`is_hiring_manager_or_recruiter = true`) | +10 |
| Remote | +15 |
| Global / Worldwide | +15 |
| Europe | +10 |
| UK | +10 |
| US | +10 |
| Relevant domain match | +10 |

### Deterministic Calculation Rules

1. **Role Gating**: A post must have `is_recruiting_post === true`, `is_product_design_role === true`, and `seniority !== 'Junior'`. If any of these is not satisfied, `finalScore = 0`. The Junior exclusion is the profile rule from §16: a junior seat is out of scope, not a weak match, so it fails the gate and is stored as `irrelevant` rather than delivered at low priority. It is evaluated **before** any signal, so a junior post that fires every other signal still scores 0.
2. **Seniority (Non-cumulative)**: Only the highest matching seniority tier awards points:
   * `Head`, `Staff`, `Principal`, `Lead`, `Senior`: +30 points.
   * `Founding`: +28 points.
   * `Mid`, `Junior`, `Unknown`: +0 points.
   Maximum seniority contribution: +30 points.
3. **Location / Arrangement (Capped)**: Remote and regional signals accumulate up to a maximum location cap of +25 points (e.g., Remote (+15) + Europe (+10) = +25).
4. **Domain Match (Capped)**: Matching any target domain in the canonical domain list awards +10 points total.
5. **Hiring Signal**: Presence of explicit hiring terms adds +20 points.
6. **Recruiter Identified**: Requires `is_hiring_manager_or_recruiter === true` to award +10 points.
7. **Score Clamping**: The final score is deterministically clamped:
   ```javascript
   finalScore = Math.min(100, Math.max(0, rawScore));
   ```
8. **Qualification and Priority**: Qualification and ranking are two separate decisions, and neither one changes the other.
   ```javascript
   eligible  = is_recruiting_post === true
            && is_product_design_role === true
            && seniority !== 'Junior';                   // profile rule, §16
   qualified = eligible;                                  // §11 confidence and §18 recency still apply
   priority  = finalScore >= MIN_RELEVANCE_SCORE ? 'high' : 'standard';
   ```

   The relevance score is **not** a qualification gate. A recruiting Product Design
   post is an opportunity whatever it scores, so a weak-but-valid signal match is a
   standard-priority match rather than a discarded post. The score is never inflated
   to reach a band: a post scoring 45 is stored as 45 and reported as standard
   priority.

   The threshold therefore decides only how a qualified post is labelled and ordered
   inside the digest — every qualified post is delivered, ranked by
   `relevance_score DESC`.

   Note that seniority is read here as the **resolved** value from §13's profile
   role policy, never the raw model output. A flat "Product Designer" title is
   therefore scored on the `Senior` row above, and the value stored in
   `linkedin_posts.seniority` is the same one.

   This must not become a general job scraper: `Junior` roles, non-design roles,
   and non-recruiting posts still fail the gate in rule 1. Seniority above the
   Junior exclusion remains a scoring signal, never a qualification gate.

Maximum score:

```text
100
```

Minimum recommended **high-priority** threshold:

```text
60
```

The threshold is configurable through `MIN_RELEVANCE_SCORE`.
Scores must be explainable from deterministic signals.

---

## 15. Relevant Domains

Domain detection is a deterministic phrase match over curated synonym groups, so vocabulary drift between the user's profile and a candidate's post ("payments" vs "fintech", "machine learning" vs "AI", "banking infrastructure" vs "financial infrastructure") does not cost a match. No model, embedding, or external taxonomy is involved, and the award stays a flat +10 however many groups match.

Generic nouns (`technology`, `software`, `product`, `platform`, `digital`, `innovation`) must never appear as standalone terms: they occur in almost every post and would disable the signal. Qualify them instead (`enterprise software`, `data platform`).

### Strong Matches

- fintech
- financial infrastructure
- payments
- AI
- B2B SaaS
- compliance
- RegTech

### Additional Relevant Domains

- Web3
- blockchain
- digital assets
- developer tools / design tools for developers
- AI design tools
- enterprise software
- design systems
- complex data-heavy products

Domain relevance contributes to the overall score but does not independently qualify a post.

---

## 16. Excluded Roles

The following roles should normally be excluded:

- Graphic Designer
- Visual Designer
- Brand Designer
- Marketing Designer
- Motion Designer
- Industrial Designer
- Interior Designer
- Fashion Designer
- Junior Designer
- Design Intern

### Junior Roles Are Enforced, Not Just Advised

`Junior` is the one exclusion that is absolute in code. §14 rule 1 rejects any
post whose classified `seniority` is `Junior`, so it is stored as `irrelevant`
and never reaches a digest. The classification prompt's role guidance alone was
never sufficient, because "Junior Product Designer" is plainly a product design
role and the prompt had no reason to mark it false.

This is evaluated before any scoring signal, so no amount of seniority-adjacent
wording, hiring language, or domain match can bring a junior post back. It also
burns the post's URL against dedup (§9), so the same junior vacancy is not
re-classified on every subsequent run.

However, exclusions are not necessarily absolute.

If a post contains an excluded term but explicitly describes substantial Product Design responsibilities, the AI classifier may classify it as a Product Design opportunity.

Example:

```text
"Product Designer / Visual Designer"
```

may still qualify if the post clearly describes product design responsibilities.

---

## 17. Database

DesignRadar uses Supabase PostgreSQL.

### `linkedin_posts`

Fields:

```text
id (uuid, primary key, default gen_random_uuid())
search_run_id (uuid, foreign key to search_runs.id, nullable)
source_provider (text, e.g. 'serper', 'brave')
linkedin_url (text, unique, not null)
author_name (text, nullable)
company_name (text, nullable)
job_title (text, nullable)
seniority (text, nullable)
location (text, nullable)
remote_status (text, nullable)
post_text (text, nullable)
application_url (text, nullable)
is_hiring_manager_or_recruiter (boolean, nullable)
published_at (timestamptz, nullable)
discovered_at (timestamptz, default now())
relevance_score (integer, default 0)
is_recruiting_post (boolean, default false)
is_product_design_role (boolean, default false)
confidence (numeric, nullable)
classification_reason (text, nullable)
source_query (text, nullable)
status (text, not null default 'qualified')
is_notified (boolean, default false)
notified_at (timestamptz, nullable)
notification_channel (text, nullable)
created_at (timestamptz, default now())
updated_at (timestamptz, default now())
```

`linkedin_url` must be unique.
Valid values for `status`: `'qualified'`, `'stale'`, `'irrelevant'`, `'low_confidence'`.

---

### `recruiters`

Fields:

```text
id (uuid, primary key, default gen_random_uuid())
name (text, not null)
linkedin_url (text, unique, nullable)
post_count (integer, default 1)
first_seen_at (timestamptz, default now())
last_seen_at (timestamptz, default now())
```

---

### `companies`

Fields:

```text
id (uuid, primary key, default gen_random_uuid())
name (text, not null)
linkedin_url (text, nullable)
website (text, nullable)
post_count (integer, default 1)
first_seen_at (timestamptz, default now())
last_seen_at (timestamptz, default now())
```

---

### `search_runs`

Fields:

```text
id (uuid, primary key, default gen_random_uuid())
started_at (timestamptz, default now())
finished_at (timestamptz, nullable)
query_count (integer, default 0)
result_count (integer, default 0)
new_post_count (integer, default 0)
candidate_count (integer, default 0)
matched_post_count (integer, default 0)
status (text, default 'running')
error_message (text, nullable)
```

---

### `notifications`

Fields:

```text
id (uuid, primary key, default gen_random_uuid())
notification_type (text, not null default 'daily_digest')
post_count (integer, default 0)
post_ids (uuid[], default '{}')
recipient (text, not null)
provider (text, not null)
provider_message_id (text, nullable)
sent_at (timestamptz, default now())
status (text, default 'sent')
error_message (text, nullable)
```

---

## 18. Recency and the Persist-Then-Filter Rule

DesignRadar prioritizes opportunities discovered and published within the previous 24 hours.

### Published Date Evaluation

```javascript
const lowerBoundary = new Date(Date.now() - 24 * 60 * 60 * 1000);
```

Search engines may or may not expose an exact publication timestamp.

1. **Verified Recent**: If `published_at` is reliably parsed and `published_at >= lowerBoundary`:
   - Post is marked with `status = 'qualified'`.
   - Included and prioritized at the top of the next daily digest.
2. **Verified Stale (Persist-to-Prevent-Reclassification)**: If `published_at` is reliably parsed and `published_at < lowerBoundary`:
   - Post is persisted in Supabase with `status = 'stale'`.
   - It is EXCLUDED from the daily digest.
   - **Crucial cost saving**: Because its normalized URL is permanently saved in Supabase, all future search runs deduplicate against it and skip it before calling AI, preventing infinite re-classification costs.
3. **Unverified Timestamp (`published_at = null`)**:
   - The system must NOT fabricate a publication date.
   - If it passes the §14 rule 1 eligibility gate and the §11 confidence gate, it is marked `status = 'qualified'` — the score is recorded for ordering and priority but never decides this.
   - Assigned `discovered_at = now()`.
   - Included in the next daily digest under "Recent Discoveries", and marked `is_notified = true` once delivered. Deduplication prevents it from ever being re-notified.

---

## 19. Discovery Frequency and Digest Cadence

### Scheduled Automation

Notifications are **server-side**. Everything below is executed by Supabase
Postgres cron calling the deployed Edge Function; no local process and no
`npm run radar` is involved.

| Job | Cron (UTC) | Local (Africa/Lagos) | Mode | Behaviour |
| --- | --- | --- | --- | --- |
| Discovery + delivery | `0 */4 * * *` | 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 | `full` | search → classify → score → persist → digest → deliver |
| Daily safety net | `0 7 * * *` | 08:00 | `digest` | re-deliver anything the 4-hour runs left unsent |

The 4-hour job runs mode **`full`**, not `discovery`, so a new opportunity
reaches ntfy within minutes of being indexed rather than waiting for the daily
digest. This is not six digests a day:

* digest selection (§20) skips posts that are already `is_notified` or
  `sent_to_digest`, so only genuinely new posts are included;
* an empty digest is not delivered at all, so a quiet four hours produce no
  notification;
* posts are marked sent only after ntfy confirms delivery, so a failure leaves
  them queued for the next job rather than silently dropping them.

The daily job is retained purely as a re-delivery safety net for failed
deliveries. With `full` on the 4-hour schedule it usually has nothing to send,
which is the intended outcome and not a duplicate.

How the jobs call the function: each `cron.schedule` body reads the project URL
and service-role key from **Supabase Vault** (`design_radar_supabase_url`,
`design_radar_service_role_key`) and issues `net.http_post` with an explicit
`timeout_milliseconds := 120000`. The timeout matters — pg_net's default is
5000 ms, shorter than a real `full` run, so the first scheduled invocation on
2026-10-06 recorded `timed_out = true` at 5 s while the function kept running.
The request is not cancelled, but the outcome was invisible; at 120000 ms
`net._http_response` retains the real HTTP status and body:

```sql
select id, status_code, timed_out, left(content, 200), created
  from net._http_response order by created desc limit 5;
```

That query, plus `cron.job_run_details`, is how a scheduled run is verified.

Configuration:

```text
TIMEZONE=Africa/Lagos
DAILY_DIGEST_HOUR=8
```

### CLI Execution Rules

These matter only for local runs; the schedules above are the automated path.

* `npm run radar`: Runs discovery, normalization, deduplication, keyword filtering, AI classification, scoring, persistence, and (mode `full`) digest + delivery.
* `npm run digest`: Standalone command to force-generate and dispatch the digest of all pending qualified posts (`status = 'qualified' AND is_notified = false`).

---

## 20. Daily Digest

The daily digest should contain qualified opportunities discovered during the relevant period.

Example:

```text
🎨 DESIGNRADAR

Senior Product Design opportunities
Daily Digest — 30 Sep 2026

Found 7 relevant opportunities.

━━━━━━━━━━━━━━
⚡ VERIFIED (LAST 24 HOURS)
━━━━━━━━━━━━━━

🔥 Senior Product Designer (Score: 85)

👤 Jane Doe
🏢 Example Pay
🌍 Remote — Europe

Fintech infrastructure startup hiring a Senior Product Designer.

🔗 LinkedIn post: https://www.linkedin.com/posts/...
📝 Apply: https://example.com/apply

━━━━━━━━━━━━━━

🔥 Lead Product Designer (Score: 75)

👤 John Smith
🏢 Example AI
🌍 Remote

AI workflow tools startup hiring a Lead Product Designer.

🔗 LinkedIn post: https://www.linkedin.com/posts/...

━━━━━━━━━━━━━━
✨ RECENT DISCOVERIES
━━━━━━━━━━━━━━

🔥 Founding Product Designer (Score: 68)

🏢 DevTools Corp
🌍 Worldwide / Remote

Developer tools startup looking for a founding product designer.

🔗 LinkedIn post: https://www.linkedin.com/posts/...

━━━━━━━━━━━━━━

Scanned: 164 posts
Qualified: 7
```

The digest should:

- prioritize the highest relevance scores
- show the job title
- show recruiter/author when known
- show company when known
- show location when known
- show remote status when known
- include a short factual description
- include the LinkedIn post URL
- include an application URL when available
- avoid fabricated information
- show useful run statistics

---

## 21. Notification Interface

Notifications must use an abstraction layer.

Create:

```javascript
export async function sendNotification(message) {}
```

The core application should not directly depend on any notification provider.

Potential notification providers:

```text
ntfy
Email
Mock
```

The MVP supports ntfy for delivery and a mock notifier for local development
and testing.

This allows the core radar pipeline to be tested without external messaging credentials.

---

## 22. ntfy

Use the ntfy HTTP API only:

```text
POST <NTFY_BASE_URL>/<NTFY_TOPIC>
Content-Type: text/plain; charset=utf-8
Title: DesignRadar — Daily Digest
```

Do not automate any chat web interface.

Do not use unofficial ntfy client libraries.

Do not use:

- Playwright
- Puppeteer
- Selenium
- browser session automation

for notifications.

The ntfy module should expose:

```javascript
sendNtfyMessage(message);
```

Expected successful response:

```javascript
{
  success: true,
  providerMessageId: "..." // ntfy's own message id, or null when it sent none
}
```

Never invent a message id, and never log or store `NTFY_TOKEN`.

### Message Chunking and Delivery Guarantee

1. **Character Limit**: ntfy rejects messages above ~4,096 bytes. The digest formatter must partition large digests into chunks of **max 3,500 characters**, breaking cleanly between post cards (never splitting an opportunity card across messages).
2. **Atomic Notification State**:
   - Posts must only be marked as notified after successful message delivery.
   - For each chunk delivered successfully, only the specific post IDs included in that chunk are updated:
     ```sql
     UPDATE linkedin_posts
     SET is_notified = true, notified_at = now(), notification_channel = 'ntfy'
     WHERE id = ANY(deliveredPostIds);
     ```
   - If a subsequent chunk fails, already delivered posts are not resent, and remaining posts remain eligible for retry.

---

## 23. Environment Variables

### Required

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
GEMINI_MODEL
SEARCH_API_KEY
```

### Providers

```text
SEARCH_PROVIDER=serper
NOTIFICATION_PROVIDER=ntfy
```

### ntfy (When NOTIFICATION_PROVIDER=ntfy)

```text
NTFY_TOPIC          # required
NTFY_BASE_URL       # optional, defaults to https://ntfy.sh
NTFY_TOKEN          # optional, only for a reserved or authenticated topic
```

### Configuration

```text
TIMEZONE=Africa/Lagos
DAILY_DIGEST_HOUR=8
DIGEST_LOOKBACK_HOURS=168
MIN_RELEVANCE_SCORE=60
```

`DIGEST_LOOKBACK_HOURS` is how far back the digest looks for qualified, unsent
posts. It defaults to 168 (one week) so a post discovered on an unlucky day is
still reported rather than silently lost. It is independent of the 24-hour
publication window that earns a post the "Verified" heading (§16), and of the
recency validity window that assigns `status` (§18).

Never commit secrets to Git.

Provide `.env.example` containing variable names but no real credentials.

---

## 24. Error Handling

### Search Provider Failure

If one search query fails:

- log the failure
- continue processing remaining queries
- include the failure in search-run statistics

A single failed query should not necessarily terminate the entire radar run.

### AI Failure

For transient AI failures:

- retry using bounded retries
- use exponential backoff where appropriate
- log the failure

For permanent validation failures:

- reject the candidate
- log the reason

### Database Failure

Database persistence failures should be treated as serious errors.

Do not report a post as successfully persisted when the database operation failed.

### Notification Failure

If notification delivery fails:

- do not mark posts as sent
- record the notification failure
- allow a later retry

### Unexpected Error

Unexpected errors should:

- be logged
- mark the radar run as failed where appropriate
- preserve enough context for debugging

---

## 25. Testing Requirements

Tests should cover at least:

1. URL normalization
2. LinkedIn URL validation
3. URL deduplication
4. keyword filtering
5. search result normalization
6. relevance scoring
7. AI response validation
8. missing fields
9. irrelevant posts
10. seniority filtering
11. 24-hour filtering
12. digest formatting
13. notification failure
14. duplicate notification prevention
15. database duplicate prevention
16. search-provider failure handling

The project should use mocked external services during unit tests.

Tests must not require real Gemini, search-provider, Supabase, or ntfy credentials.

---

## 26. MVP Definition

The MVP is complete when a developer can run:

```bash
npm run radar
```

and DesignRadar can:

1. Generate search queries.
2. Search the configured public web-search provider.
3. Extract LinkedIn post URLs.
4. Normalize LinkedIn URLs.
5. Deduplicate results.
6. Apply inexpensive keyword filtering.
7. Classify candidates using AI.
8. Apply deterministic relevance scoring and derive the eligibility gate (§14).
9. Derive `status` from eligibility, confidence, and recency — never from the score.
10. Store qualified results in Supabase.
11. Generate a daily digest.
12. Send the digest through the configured notifier.
13. Prevent already-sent posts from being sent again.
14. Record the radar run and notification results.

The MVP does **not** require a frontend.

---

## 27. Development Commands

Expected commands:

```bash
npm run radar
npm run digest
npm run test
npm run lint
```

If a command is not required by the implementation, remove it rather than leaving a broken or misleading command.

---

## 28. Development Principles

### Keep the architecture modular

Separate:

```text
Search
AI
Scoring
Database
Notifications
Radar orchestration
Utilities
```

### Prefer simple working implementations

Avoid premature abstraction.

Introduce abstractions where they provide clear value, especially around external providers.

### Provider independence

Search providers must be replaceable without rewriting the radar pipeline.

Notification providers must be replaceable without rewriting the radar pipeline.

### Data integrity

Never fabricate:

- recruiter names
- company names
- job titles
- locations
- publication dates
- application URLs
- remote status

Unknown information should remain unknown.

### Security

Never commit:

- API keys
- Supabase service-role keys
- ntfy tokens
- personal access tokens
- `.env` files containing secrets

### Technology constraints

The project uses:

- JavaScript
- Node.js
- npm
- Supabase
- Google Gemini API
- Public web search/indexing

The project must **not** use TypeScript.

The project must **not** scrape LinkedIn through authenticated browser automation.

The project must **not** automate a chat web interface.

The project must **not** use unofficial ntfy or chat automation libraries.

### MVP scope

Do not build a frontend in the MVP.

The first goal is to make this pipeline reliable:

```text
Search
  ↓
LinkedIn Posts
  ↓
Normalize
  ↓
Deduplicate
  ↓
Filter
  ↓
AI Classification
  ↓
Relevance Score
  ↓
Supabase
  ↓
Daily Digest
  ↓
Notification
```

A dashboard can be added as a future V2 once the underlying data pipeline is reliable.

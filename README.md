# Portfolio Build Tracker

> Engineering ops and release management for the 30 apps in 30 days portfolio.

**URL:** https://app1.breakthruventures.ai (going live with the Day 1 deploy) · **Runs on:** AWS ·
Part of [30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

## What this app does

Engineering leads and release managers face a common visibility challenge: keeping track of dozens of services
across disparate repositories and clouds without clicking through ten dashboards. The Portfolio Build Tracker acts
as mission control for the 30 apps portfolio. It aggregates GitHub webhook events, CI results, live service health
probes, and cloud free-tier usage into one board with an AI-generated daily health summary.

### The Three Audiences

- **Public & Signed-in Users:**
  Anyone (anonymous visitors or authenticated users with the `user` role) can view the public board and app detail
  pages. The board displays all 30 apps with status chips, health dots, CI conclusions, time since the last push, and
  today's AI summary line. Public responses never include private notes, user emails, actor ids or health-check URLs; history shows the actor only as `system` or `admin`.
- **Admin (Michael):**
  Authenticated administrators (`admin` role) have exclusive authorization to perform status transitions, set custom
  health URL overrides, write private administrative notes, run a catalog/health sync on demand, and
  regenerate an app's AI summary (once per app per hour).
- **Machines:**
  - **GitHub:** Delivers `push`, `pull_request`, and `workflow_run` webhooks signed via HMAC-SHA256.
  - **Ops Monitor:** Overnight agent reporting CI status, stalled branches, and cloud free-tier usage via token-authenticated ingest.
  - **Scheduled Workflow:** GitHub Actions calling periodic health syncs (every 30 minutes) and the daily summary loop (at 06:00 UTC).

## Status State Machine

The lifecycle of each app follows a strict state machine: `planned → building → live → shipped`, with `blocked`
available as a side state. Operational health (`ok | degraded | down | unknown`) is tracked separately so that a
shipped app experiencing downtime remains `shipped` while alerting on health.

| From → to | Caused by | Conditions / Rules |
| --- | --- | --- |
| `planned → building` | GitHub webhook or Admin | Auto-triggered on the first `push` or `pull_request` event for the repository. |
| `building → live` | Sync endpoint or Admin | Auto-triggered when sync verifies `/api/health` returns 200 with `status: "ok"` and `version != "dev"`. |
| `live → shipped` | Admin only | Final milestone after production DNS is mapped and the app is announced. |
| `live → building`, `shipped → live` | Admin only | Backward transitions require an explicit explanation reason (rework or rollback). |
| `planned`, `building`, `live → blocked` | Admin only | Requires an explanation reason; the preceding state is saved in `blocked_from`. |
| `blocked → stored state` | Admin only | Restores the application to the state stored in `blocked_from`. |

Automatic transitions only advance status forward and never leave `blocked`. Illegal transitions are rejected with HTTP 409 Conflict. Every change logs an immutable `status_transition` record.

## How Data Arrives

Data is ingested through three external machine endpoints. Because the service deploys to AWS Lambda (behind API Gateway with a 29-second execution timeout and scale-to-zero semantics), **there is no persistent background cron daemon on Lambda**. All background tasks are driven by external HTTP calls.

```
 GitHub (push, PR, CI)     Ops Monitor (overnight check)     GitHub Actions (cron)
         │                               │                             │
         │ HMAC-SHA256                   │ Bearer INGEST_TOKEN         │ Bearer SYNC_TOKEN
         ▼                               ▼                             ▼
 POST /api/webhooks/github       POST /api/ingest              POST /api/sync
                                                               POST /api/summaries/run
```

1. **GitHub Webhooks (`POST /api/webhooks/github`):**
   Receives raw body payloads (up to 1 MB). Verifies authenticity timing-safely via `X-Hub-Signature-256` and
   `GITHUB_WEBHOOK_SECRET`. Webhooks are idempotent via `X-GitHub-Delivery` deduplication in `app_event`. Automatically
   transitions `planned` apps to `building` upon the first push or PR.
2. **Ops Monitor Ingest (`POST /api/ingest`):**
   Receives overnight status reports from the ops monitor harness. Authenticated timing-safely with `INGEST_TOKEN`.
   Accepts up to 64 KB of zod-validated structured JSON to record CI conclusions, stalled development flags, and
   cloud resource utilization.
3. **Scheduled Sync (`POST /api/sync`):**
   Triggered every 30 minutes by a GitHub Actions workflow using `SYNC_TOKEN`, or by a signed-in admin (same-origin requests only). Re-reads
   `catalog.yaml` to sync names and cloud metadata, and polls active apps' `/api/health` (10 concurrently, 6s timeout,
   16 KB body limit). Auto-transitions verified apps from `building` to `live`.

A machine endpoint whose secret is unset answers 503, so nothing is open by default. (One deliberate exception: a signed-in admin can run sync and summaries from the app itself before `SYNC_TOKEN` exists.)

## API

| Path | Who | What |
| --- | --- | --- |
| `GET /api/board` | public | All 30 apps: status, health, CI, last push, today's summary |
| `GET /api/apps/:n` | public | One app: status history, last 20 events, today's summary and flags |
| `POST /api/apps/:n/transition` | admin | `{to, reason?}`; enforces the state machine (409 illegal, 400 missing reason) |
| `PATCH /api/apps/:n` | admin | `{health_url}` (https, allow-listed host) or `null` to clear |
| `POST /api/apps/:n/notes`, `DELETE /api/apps/:n/notes/:id` | admin; delete by author only | Private notes |
| `POST /api/webhooks/github` | GitHub | Signed events (below) |
| `POST /api/ingest` | ops monitor | Nightly report (below) |
| `POST /api/sync` | scheduled workflow or admin | Catalog refresh and health polling |
| `POST /api/summaries/run` | scheduled workflow or admin | Daily AI summaries, 6 apps per call; returns `{done, remaining}`. Admin may send `{n}` to regenerate one app |
| `GET /api/health` | public | Liveness and database check |

The UI uses server actions in `src/app/actions/tracker.ts` that call the same data functions.

## Machine endpoints (details)

All three return `503 {"error":"not configured"}` while their secret is unset, and `401` for a missing or wrong
credential. Secrets are never logged.

| Endpoint | Caller | Credential |
| --- | --- | --- |
| `POST /api/webhooks/github` | GitHub (events `push`, `pull_request`, `workflow_run`; `ping` answers 200, others 202) | `X-Hub-Signature-256` HMAC with `GITHUB_WEBHOOK_SECRET`; body up to 1 MB; deduped on `X-GitHub-Delivery`; repos outside `BreakthruDevelopment/<catalog repo>` answer 202 |
| `POST /api/ingest` | ops monitor, nightly | `Authorization: Bearer $INGEST_TOKEN`; body up to 64 KB |
| `POST /api/sync` | scheduled workflow, or a signed-in admin | `Authorization: Bearer $SYNC_TOKEN`, or an admin session; returns `{"catalog":{"updated":N},"health":{"checked":N,"ok":N,"down":N,"skipped":N}}` |

Sync re-reads `catalog.yaml` (names, subdomains, clouds, repos; never status), then polls
`app.health_url ?? https://<subdomain>/api/health` for every app that is not `planned`. Each URL is re-checked
against the host allow-list, its DNS answers must all be public addresses (loopback, private, link-local,
CGNAT, ULA and unspecified are refused, IPv4-mapped IPv6 included), redirects are not followed, and a
check has 6 s and 16 KB. A refused check counts as `skipped`, not `down`. The last sync and ingest times are
stored in the `tracker_state` table (`last_sync`, `last_ingest`) for `/admin`.

### Ingest API (the ops monitor's nightly report)

`POST /api/ingest` with `Authorization: Bearer <INGEST_TOKEN>` and `Content-Type: application/json`.

```json
{
  "reported_at": "2026-11-04T03:00:00Z",
  "apps": [
    {
      "n": 3,
      "ci": { "conclusion": "failure", "workflow": "ci", "url": "https://github.com/BreakthruDevelopment/03-expense-tracker/actions/runs/123" },
      "stalled": [{ "kind": "pr_waiting", "detail": "PR #4 waiting on review", "hours": 26 }]
    },
    { "repo": "04-habit-tracker", "stalled": [{ "kind": "no_push", "detail": "No push since Monday", "hours": 52 }] }
  ],
  "clouds": [
    {
      "cloud": "aws",
      "metrics": [{ "metric": "lambda_requests", "used_pct": 82, "charge_cents": 0 }]
    }
  ],
  "summary": "29 apps checked; 1 failing CI; AWS Lambda at 82% of free tier."
}
```

| Field | Rules |
| --- | --- |
| `reported_at` | ISO 8601 with offset or `Z`. Future times are clamped to now |
| `apps` | Optional, defaults to empty. Up to 30. Each needs `n` (1 to 30) or `repo` (the catalog repo name, case-insensitive); unknown apps are skipped and counted |
| `apps[].ci` | `conclusion` (1-40 chars), `workflow` (1-100), optional `url` (must be an `https://github.com` link). Written as an `ops_monitor` event and, if newer than the stored result, to the app's CI columns |
| `apps[].stalled[]` | Up to 10: `kind` (1-40), `detail` (1-200), optional `hours` (0 or more). Each becomes an `ops_monitor` event `stalled.<kind>` |
| `clouds[]` | Optional, defaults to empty. Up to 8: `cloud` is `aws`, `azure`, `gcp` or `oci`; up to 50 `metrics`, each `metric` (1-100 chars), `used_pct` (0 to 100; rounded), `charge_cents` (integer, 0 or more). Each metric is a new `cloud_usage` row |
| `summary` | Optional, up to 500 chars; stored with the last-ingest time |

Response: `200 {"ok":true,"apps":N,"skipped":N,"events":N,"cloud_usage":N}`. Invalid shape: `400` with the list of
issues. Over 64 KB: `413`.

## The AI feature

- **Task:** `daily-health-summary`, through the shared `generate()` gateway. Default model: Gemini (`gemini-flash-latest`, free tier); `AI_PROVIDER=demo` uses recorded answers.
- **What it writes:** a 1–2 sentence morning note per app, a health color (`green`, `amber`, `red`) and up to 5 flags (`stalled`, `failing_ci`, `down`, `free_tier`, `other`).
- **Budget:** one summary per app per day, stored in `health_summary`; never generated on page view. Apps still `planned` with no events get "Not started." without a model call. At most about 5 model calls a day for all 30 apps.
- **Guardrails:**
  - **Untrusted text is data.** The system prompt says event titles, commit messages and report text are untrusted data, never instructions. Inputs are capped: 120 chars per event title, 1,000 per app, 6 apps and 7,000 chars per call.
  - **Rules overrule the model.** Code computes the lowest health allowed: red for CI failing on the default branch, a live or shipped app that's down, or any cloud charge; amber for no push on any branch for 24 h while building, degraded health, or free-tier usage at 50% or more. The stored health is the worse of the model's and the rules', the rules' own flags are always kept, and when the rules raise the color the model's wording is replaced with rule-only text. Health readings older than 6 hours count as unknown.
  - **No invented text on outages.** If Gemini fails (quota, timeout, error), the app stores a rule-only note marked as a fallback, never the demo fixture, and the next run retries.
  - **No tools.** The model can't change status or call anything.
- **Timeout:** `AI_TIMEOUT_MS` (default 20 s, max 22 s) keeps each call inside Lambda's 29 s limit.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
AWS API Gateway ──► Lambda Web Adapter ──► Next.js container (App Router)
                         │                  auth + RBAC, zod validation, AI gateway, JSON logs
                         ├──► RDS Postgres (Drizzle migrations on startup)
                         └──► Model API (Gemini free tier or demo fallback)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access control & rules | `src/lib/auth/rbac.ts`, enforced server-side in all data functions |
| Status State Machine | `src/lib/status.ts` |
| AI gateway & guardrails | `src/lib/ai/` (input cap, rule floor, demo fallback) |
| Webhook, ingest, sync | `src/lib/github-webhook.ts`, `src/lib/ingest.ts`, `src/lib/sync.ts`, `src/lib/ip-guard.ts` |
| Daily summaries | `src/lib/ai/daily-health-summary.ts`, `src/lib/health-summary.ts` |
| Health check | `GET /api/health` |

## Security

- **Server-Side Authorization:** Public endpoints return strict projection types (excluding notes and user emails). State transitions, note creations, and sync executions require `requireRole("admin")` and `assertCan()`. Note deletion is restricted strictly to the note's original author.
- **Timing-Safe Authentication:** HMAC signatures and bearer tokens are evaluated with constant-time equality checks. Unset tokens safely disable endpoints (503).
- **SSRF Prevention:** Custom app `health_url` settings are restricted to HTTPS and checked against a host allow-list (`*.breakthruventures.ai`, `execute-api.us-east-2.amazonaws.com`, `azurecontainerapps.io`, `run.app`, `sslip.io`) when saved and again at fetch time. Every DNS answer must be a public address (private, loopback, link-local, CGNAT and ULA ranges are refused), redirects are not followed, and each check has 6 s and 16 KB.
- **Same-origin admin actions:** sync and summary runs from an admin session must come from the app's own origin, so sibling apps on the same domain can't trigger them.
- **Zero Secrets Committed:** Secret values are injected from cloud parameter stores or environment secrets; `.env.local` is ignored by git.

## Environment Variables

Names only (never commit secret values):

| Variable | Description |
| --- | --- |
| `APP_NAME` | Display name of the application |
| `APP_URL` | Public base URL used for cookies, CORS, and auth redirects |
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | 32+ character key used by Better Auth to encrypt sessions |
| `AI_PROVIDER` | AI provider to use (`gemini`, `anthropic`, or `demo`) |
| `AI_MODEL` | Optional model name override |
| `GEMINI_API_KEY` | Google Gemini API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `AI_TIMEOUT_MS` | Model call timeout in ms (default 20000, max 22000) |
| `AI_FALLBACK_TO_DEMO` | Fallback to recorded demo answers on quota or network error (`true`/`false`) |
| `LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`) |
| `MIGRATE_ON_START` | Run pending database migrations automatically at server startup (`true`/`false`) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for verifying GitHub webhook deliveries (16+ chars) |
| `INGEST_TOKEN` | Bearer token for ops monitor ingest calls (16+ chars) |
| `SYNC_TOKEN` | Bearer token for scheduled sync and summary runs (16+ chars) |
| `SEED_ADMIN_EMAIL` | Optional initial admin user email for `pnpm db:seed` |
| `SEED_ADMIN_PASSWORD` | Optional initial admin password for `pnpm db:seed` |
| `SEED_USER_EMAIL` | Optional regular user email for `pnpm db:seed` |
| `SEED_USER_PASSWORD` | Optional regular user password for `pnpm db:seed` |

## Run locally

```bash
cp .env.example .env.local          # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

To make yourself an admin, sign up first, then (while the app is running):
```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=your-secure-password pnpm db:seed
```

## Design system

Every app shares the Breakthru look (guide and concept: `ai-dev-os/design/`). Tokens live in `src/app/globals.css`
(light and dark; use `bg-surface`, `text-muted`, `border-border`, `bg-accent` and the status tokens, never raw colors).
Fonts load through `next/font/google` in `src/app/layout.tsx`: Newsreader (`font-display`), Public Sans (`font-sans`),
IBM Plex Mono (`font-mono`). Set the app's name once in `src/lib/app-config.ts` (`APP_TITLE`, or the `APP_NAME` variable).

| Component | Location | Use |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Header (logo, app name, nav, sign in or user and sign out) and footer; wraps every page in the root layout |
| `PageIntro` | `src/components/ui/` | Eyebrow, Newsreader headline, one-line description, actions |
| `StatTile`, `StatGrid` | `src/components/ui/` | A number and a label; tiles stack at 375px |
| `FilterBar` | `src/components/ui/` | Search, select filters, sort and table/cards toggle as a GET form (state in the URL) |
| `StatusBadge` | `src/components/ui/` | Live, building, blocked, not started (neutral), healthy, degraded, down |
| `DataList` | `src/components/ui/` | Table from 640px, cards below |
| `Panel` | `src/components/ui/` | Titled panel; `collapsible` adds a "Show all" toggle (small client component) |
| `DemoBadge` | `src/components/ui/` | "Demo data" label for seeded or demo content |

The header links come from `NAV_LINKS` in `src/lib/app-config.ts`: Board (`/`) and admin-only Admin (`/admin`).
The title defaults to Build Tracker. The board keeps search (`q`), cloud (`cloud`), status (`status`), sort
(`number`, `recent`, `status`), and view (`table`, `cards`) in the URL. Active apps show service/build information
and the latest summary; planned apps stay in a collapsed neutral backlog. Screenshots from the local 30-app
demo seed are in [docs/screenshots](docs/screenshots/README.md).

Shared button and field classes are in `src/components/ui/styles.ts` (44px minimum height). Don't add `loading.tsx` or
`<Suspense>` above a page that calls `requireRoleOrRedirect()` or `notFound()`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests and type checks
TEST_DATABASE_URL=postgres://... pnpm test # runs Postgres integration tests
pnpm build && pnpm smoke                   # build, then the end-to-end smoke test against a running app
```

## Deploy it yourself

The application image runs across AWS, Azure, Google Cloud, and Oracle Cloud. Infrastructure and deploy automation are managed through Terraform in [BreakthruDevelopment/30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra). Secret values come from AWS Parameter Store (see that repo's "Per-app secrets").

## Demo data

To design or demo the board with a full screen, fill a **non-production** database with realistic sample
state for all 30 apps (statuses, health, CI, events, status history, today's summaries, cloud usage):

```bash
DATABASE_URL=postgres://... APP_URL=http://localhost:3000 DEMO_SEED=yes pnpm seed:demo
```

The data is deterministic (seeded PRNG), and running it again resets the demo state. It refuses to run
without `DEMO_SEED=yes`, when `APP_URL` points at the production tracker, or when the database already
holds real GitHub events (override with `--force`). Demo rows are marked: event `delivery_id` starts with
`demo-`, summaries have `model = 'demo-seed'`. It adds one login-less user, `demo-seed-admin`, as the actor
of admin status changes. It does not create notes.

## 2-minute demo script

The board is at `/`, each app at `/apps/1` through `/apps/30`, with admin controls on each app page and config and sync at `/admin` once you sign in as an admin.

1. **Open the Public Board (`/`):**
   Navigate to `https://app1.breakthruventures.ai`. Point out the portfolio overview: the total, live, planned and blocked tiles, status tabs, the search, cloud and sort filters with a Table/Cards toggle, the Active apps panel with health, CI and the latest AI summary, and the planned backlog, collapsed by default. Show that the view works responsively on mobile (375px) without horizontal scrolling.
2. **Inspect an App Detail Page (`/apps/1`):**
   Open the **Portfolio Build Tracker** row (or card in Cards view). View its live health status, recent GitHub events (pushes, pull requests, CI runs), and today's AI-generated morning health note. Note that signed-out visitors see no administrative edit controls.
3. **Sign In as Admin (`/sign-in`):**
   Sign in with admin credentials. Return to `/apps/1` to reveal the administrator tools: the status transition dropdown, health URL override field, and admin notes thread.
4. **Demonstrate State Machine Enforcement:**
   Attempt a status transition (e.g. `building → live` or `live → blocked`). Highlight that backward or blocking transitions require an explicit explanation reason, and transitions are validated against the state machine.
5. **Inspect Admin Operations (`/admin`):**
   Visit `/admin`. Confirm the secret status check (showing set/unset without leaking secrets), inspect timestamps for the last external sync and ops ingest, and click **Run sync now** to verify immediate health polling.
6. **Show AI Summary & Guardrail Demo:**
   Trigger an AI health summary run. Point out how untrusted event titles and commit messages are sandboxed as data, and how the deterministic rule floor ensures that any failing CI or service degradation immediately overrides model output to red or amber.

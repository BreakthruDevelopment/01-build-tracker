# 30 Apps Template

The starting point for every app in Breakthru Ventures' **30 apps in 30 days** portfolio. Each app is a
responsive web app with a Postgres database, sign-in with roles, one AI feature, and a single container
image that deploys to AWS, Azure, Google Cloud or Oracle Cloud.

## What this app does

_Each app replaces this section: the customer problem, who uses it, and what the AI feature does._

Work in progress: the data model and the 30-app catalog seed are in place; the API, webhooks, AI summary and
board UI follow in later issues.

## Machine endpoints

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

### Ingest API

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

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle; pgvector available for RAG)
   └──► Model API (Gemini free tier, Claude optional, or recorded demo answers)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access rules | `src/lib/auth/rbac.ts`, enforced in every data function |
| AI gateway | `src/lib/ai/` — input cap, JSON schema validation, demo fallback |
| Health check | `GET /api/health` (503 if the database is down) |

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed`
while the app is running.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
```

CI runs all of these plus both container builds on every pull request.

## Deploy

Every push to `main` publishes a multi-arch image (x86 and ARM) to GitHub Container Registry as
`ghcr.io/breakthrudevelopment/<repo>:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys those tags to AWS, Azure, Google Cloud and Oracle Cloud with Terraform; this repo holds no cloud credentials.

With `MIGRATE_ON_START=true` the server applies pending migrations before taking traffic, holding a Postgres
advisory lock so instances starting together can't race. `pnpm db:migrate` does the same by hand.

## Using the AI feature

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `demo` (default) | Recorded answers from `src/lib/ai/demo.ts`; no key, no network |
| `gemini` | Google Gemini API (`GEMINI_API_KEY`, free tier) |
| `anthropic` | Claude (`ANTHROPIC_API_KEY`) |

With `AI_FALLBACK_TO_DEMO=true`, a quota error or outage serves the recorded answer and the UI says so.

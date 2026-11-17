# Recorded demo (Playwright + Screen Studio)

`demo/` holds a scripted walkthrough of the Build Tracker. Playwright drives a visible Chromium window at
human speed; [Screen Studio](https://www.screen.studio/) records that window on the Mac and adds the
polish (auto-zoom on clicks, smooth cursor, background). Every take is identical, so a re-record is a
re-run.

This is separate from the unit tests: vitest only reads `src/**/*.test.ts` and `test/**/*.test.ts`.

## The story (about 40 seconds)

1. The board: totals, active apps with health, CI and the AI summary line.
2. Open the **Planned backlog** and pick app 21, Meeting Notes (`DEMO_APP` picks another planned app).
3. As admin, move it **Planned → Building → Live → Shipped** with the Change status form.
4. Show the public Status history with every step.
5. Back on the board, filter to **Shipped** and find the app.
6. Open **Admin** (portfolio controls: configuration, last sync, last ingest).

The tracker has no "add app" screen: apps come from the 30-app catalog, so the story starts from a
planned app instead.

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium     # browser for Playwright (or set DEMO_BROWSER_CHANNEL=chrome)
docker compose up -d db                   # local Postgres, if you don't have one
cp .env.example .env.local                # set BETTER_AUTH_SECRET; AI_PROVIDER=demo is fine
set -a; source .env.local; set +a
pnpm db:migrate
```

### Demo account (never committed)

Status changes are admin-only, so the demo signs in as an admin. Pick an email and a password of at
least 10 characters, keep them in your shell or a password manager, and create the account through
the existing seed (it signs up through the running app, then grants the role):

```bash
export DEMO_EMAIL="you+demo@example.com"   # any address; local only
export DEMO_PASSWORD="..."                 # type it, don't commit it
pnpm dev                                   # in another terminal
SEED_ADMIN_EMAIL="$DEMO_EMAIL" SEED_ADMIN_PASSWORD="$DEMO_PASSWORD" pnpm db:seed
```

### Demo data

Use the existing deterministic demo seed (clean, realistic portfolio state; it refuses production):

```bash
DEMO_SEED=yes pnpm seed:demo --force
```

Run it again **before every take**: it puts app 21 back to Planned. `--force` is needed after the
first take because the demo's own status changes count as real admin changes.

## Recording a take

1. Start the app. For a clean recording use a production build, which has no Next.js dev badge:
   `pnpm build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/ && node .next/standalone/server.js`.
   `pnpm dev` also works (the demo starts it for you if nothing is listening on port 3000).
2. Reset the data: `DEMO_SEED=yes pnpm seed:demo --force`.
3. Run `pnpm demo` (with `DEMO_EMAIL` and `DEMO_PASSWORD` exported).
   It signs in once and saves the session to `demo/.auth/` (gitignored); later runs reuse it while it still works.
4. A 1440×900 Chromium window opens on the board and waits 5 seconds. In that time, start Screen
   Studio, choose **Window** and click the Chromium window.
5. Playwright plays the story, then holds on the last screen for 3 seconds and closes the window.
   Stop the recording when the hold starts or ends.
6. Trim the start and end in Screen Studio and export.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `DEMO_EMAIL`, `DEMO_PASSWORD` | none | Demo admin account. Only needed when no valid saved session exists. |
| `DEMO_BASE_URL` | `http://localhost:3000` | App to drive. Never point it at production. |
| `DEMO_APP` | `21` | Planned app to move through the statuses. |
| `DEMO_SLOWMO` | `400` | Milliseconds between Playwright actions. |
| `DEMO_START_DELAY` | `5000` | Milliseconds to wait before the first click. |
| `DEMO_FINAL_HOLD` | `3000` | Milliseconds to hold the last screen. |
| `DEMO_BEATS` | on | `off` skips the reading pauses. |
| `DEMO_HEADLESS` | unset | `1` runs without a window. |
| `DEMO_REAUTH` | unset | `1` signs in again even if the saved session still works. |
| `DEMO_BROWSER_CHANNEL` | unset | `chrome` uses installed Google Chrome. |
| `DEMO_SERVER_CMD` | `pnpm dev` | Command used to start the app if nothing answers `/api/health`. |
| `DEMO_NO_SERVER` | unset | `1` never starts a server. |

## Headless smoke run

`pnpm demo:ci` runs the same story headless with no pauses (about 10 seconds). It isn't wired into CI
yet; it can become a smoke test later.

## AI

The board's summaries come from the demo seed and `AI_PROVIDER=demo` is enough. The story doesn't
call a model.

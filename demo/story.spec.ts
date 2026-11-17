/**
 * Build Tracker demo story, about 90 seconds headed:
 *   board overview -> open a planned app from the backlog -> Planned > Building > Live > Shipped
 *   -> back to the board -> admin portfolio controls.
 *
 * Needs the admin demo account (status changes are admin-only) and the demo seed, which leaves
 * apps 21-30 Planned. DEMO_APP picks the app to move (default 21, Meeting Notes). Re-run
 * `pnpm seed:demo --force` (with DEMO_SEED=yes) before each take to put it back to Planned.
 */
import { expect, test, type Page } from "@playwright/test";
import { beat, finalHold, startDelay } from "./helpers";

const APP = Number(process.env.DEMO_APP ?? 21);

async function moveTo(page: Page, label: "Building" | "Live" | "Shipped") {
  const panel = page.getByRole("region", { name: "Change status" });
  await panel.getByLabel("New status").selectOption({ label });
  await beat(page, 800);
  await panel.getByRole("button", { name: "Update status" }).click();
  await expect(panel.getByText(`From ${label}.`)).toBeVisible();
  await beat(page);
}

test("Build Tracker: move an app from Planned to Shipped", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Portfolio overview" })).toBeVisible();
  await startDelay(page);

  // 1. The board: totals, active apps with health and CI, the AI summary line.
  await beat(page, 2_000);
  await page.mouse.wheel(0, 500);
  await beat(page);

  // 2. Open the planned backlog and pick the app to build next.
  const backlog = page.getByRole("region", { name: /Planned backlog/ });
  await backlog.getByRole("button", { name: /^Show all/ }).click();
  await beat(page);
  const appLink = backlog.locator(`a[href="/apps/${APP}"]`).first();
  await appLink.scrollIntoViewIfNeeded();
  await beat(page, 800);
  await appLink.click();
  await page.waitForURL(`**/apps/${APP}`);
  const panel = page.getByRole("region", { name: "Change status" });
  await expect(panel.getByText("From Planned.")).toBeVisible();
  await beat(page);

  // 3. Walk the state machine. Each move is validated on the server and lands in the public history.
  await panel.scrollIntoViewIfNeeded();
  await beat(page, 800);
  await moveTo(page, "Building");
  await moveTo(page, "Live");
  await moveTo(page, "Shipped");

  // 4. The public status history now shows every step.
  const history = page.getByRole("region", { name: "Status history" });
  await history.scrollIntoViewIfNeeded();
  await beat(page, 2_000);

  // 5. Back on the board, the app counts as shipped.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Portfolio overview" })).toBeVisible();
  await beat(page);
  await page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: /^Shipped/ }).click();
  await expect(page.locator(`a[href="/apps/${APP}"]`).first()).toBeVisible();
  await beat(page, 2_000);

  // 6. Portfolio controls for the admin: configuration, last sync and ingest.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("region", { name: "Last sync" })).toBeVisible();
  await beat(page);
  await page.mouse.wheel(0, 400);
  await finalHold(page);
});

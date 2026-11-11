/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Build Tracker";

export const APP_DESCRIPTION = "Part of the Breakthru Ventures app portfolio.";

/**
 * Highest app number and largest catalog the tracker accepts. The portfolio is 32 apps today; 40 leaves headroom
 * so adding apps to the ai-dev-os catalog never breaks sync. The DB check `app_n_range` (schema.ts) mirrors it.
 */
export const MAX_PORTFOLIO_APPS = 40;

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `adminOnly` links are hidden for other users; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/", label: "Board" },
  { href: "/admin", label: "Admin", adminOnly: true },
];

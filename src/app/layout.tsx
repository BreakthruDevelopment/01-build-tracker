import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import "./globals.css";

const appName = process.env.APP_NAME ?? "30 Apps Template";

export const metadata: Metadata = {
  title: { default: appName, template: `%s · ${appName}` },
  description: "Part of the Breakthru Ventures 30 apps in 30 days portfolio.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Stop prerendering before the session lookup, so `next build` does not need secrets.
  await connection();
  const user = await getCurrentUser();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full min-w-0 flex-col">
        <header className="border-b border-border bg-surface">
          <nav
            aria-label="Main"
            className="mx-auto flex w-full min-w-0 max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <Link href="/" className="min-w-0 break-words font-semibold tracking-tight">
              {appName}
            </Link>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {user?.role === "admin" ? (
                <Link href="/admin" className="font-medium hover:text-accent">
                  Admin
                </Link>
              ) : null}
              {user ? (
                <span className="max-w-40 truncate text-muted">{user.name}</span>
              ) : (
                <Link href="/sign-in" className="text-muted hover:text-foreground">
                  Sign in
                </Link>
              )}
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:py-8">{children}</main>
        <footer className="mx-auto w-full min-w-0 max-w-6xl px-4 py-6 text-xs text-muted">
          Built by Breakthru Ventures ·{" "}
          <a href="https://breakthruventures.ai" className="underline underline-offset-2">
            breakthruventures.ai
          </a>
        </footer>
      </body>
    </html>
  );
}

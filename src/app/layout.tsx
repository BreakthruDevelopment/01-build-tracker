import type { Metadata, Viewport } from "next";
import Link from "next/link";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              {appName}
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/dashboard" className="text-muted hover:text-foreground">
                Dashboard
              </Link>
              <Link href="/sign-in" className="text-muted hover:text-foreground">
                Sign in
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
        <footer className="mx-auto w-full max-w-4xl px-4 py-6 text-xs text-muted">
          Built by Breakthru Ventures ·{" "}
          <a href="https://breakthruventures.ai" className="underline underline-offset-2">
            breakthruventures.ai
          </a>
        </footer>
      </body>
    </html>
  );
}

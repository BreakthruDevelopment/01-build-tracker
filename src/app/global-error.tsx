"use client";

import "./globals.css";

export default function GlobalError({ retry }: { error: unknown; reset: () => void; retry: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-background px-4 py-8 text-foreground">
        <h1 className="text-xl font-semibold">The tracker failed to load</h1>
        <p className="mt-2 max-w-md text-sm text-muted">Something went wrong. Try again in a moment.</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 rounded-card bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
        >
          Try again
        </button>
      </body>
    </html>
  );
}

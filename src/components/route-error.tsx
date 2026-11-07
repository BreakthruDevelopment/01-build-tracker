"use client";

import { primaryButtonClass } from "@/components/styles";

export function RouteError({
  title,
  retry,
}: {
  title: string;
  error: unknown;
  reset: () => void;
  retry: () => void;
}) {
  return (
    <div className="space-y-3 rounded-card border border-border bg-surface p-4" role="alert">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">Something went wrong loading this page. Try again in a moment.</p>
      <button type="button" onClick={() => retry()} className={primaryButtonClass}>
        Try again
      </button>
    </div>
  );
}

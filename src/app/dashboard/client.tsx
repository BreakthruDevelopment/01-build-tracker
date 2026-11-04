"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { signOut } from "@/lib/auth/client";
import { type ActionState, type SummaryState, addItemAction, summarizeAction } from "./actions";

const input =
  "w-full rounded-card border border-border bg-surface px-3 py-2 text-base outline-none focus:border-accent";

export function AddItemForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    const result = await addItemAction(prev, form);
    if (result.ok) formRef.current?.reset();
    return result;
  }, {});

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <input name="title" placeholder="Title" required maxLength={200} className={input} />
      <textarea name="body" placeholder="Details (optional)" rows={2} maxLength={5000} className={input} />
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add item"}
      </button>
    </form>
  );
}

export function SummaryPanel() {
  const [state, setState] = useState<SummaryState | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="space-y-3 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">AI summary</h2>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => setState(await summarizeAction()))}
          className="rounded-card border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Summarizing…" : "Summarize my items"}
        </button>
      </div>
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      {state?.summary && (
        <div className="space-y-2 text-sm">
          <p>{state.summary}</p>
          {state.highlights && state.highlights.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-muted">
              {state.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {state.demo && (
            <p className="text-xs text-muted">Demo answer: the live model is off or over its free quota.</p>
          )}
        </div>
      )}
      {!state && (
        <p className="text-sm text-muted">Generates a short summary of your items with the app&apos;s model.</p>
      )}
    </section>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.push("/sign-in");
        router.refresh();
      }}
      className="rounded-card border border-border px-3 py-1.5 text-sm"
    >
      Sign out
    </button>
  );
}

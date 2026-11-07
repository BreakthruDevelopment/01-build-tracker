"use client";

import { useActionState } from "react";
import { runSyncFormAction } from "@/app/actions/tracker";
import { emptyFormState } from "@/app/actions/form-state";
import { FormMessages } from "@/components/form-messages";
import { primaryButtonClass } from "@/components/styles";

export function SyncForm() {
  const [state, action, pending] = useActionState(runSyncFormAction, emptyFormState);
  return (
    <form action={action} className="min-w-0 space-y-3" aria-busy={pending}>
      <FormMessages state={state} />
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Syncing…" : "Run sync now"}
      </button>
      <p className="text-sm text-muted">
        Refreshes catalog names and polls health for apps that are not planned. This can take up to 20 seconds.
      </p>
    </form>
  );
}

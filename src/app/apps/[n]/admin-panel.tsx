"use client";

import { useActionState, useState } from "react";
import {
  addNoteFormAction,
  deleteNoteFormAction,
  healthUrlFormAction,
  regenerateFormAction,
  transitionFormAction,
} from "@/app/actions/tracker";
import { emptyFormState } from "@/app/actions/form-state";
import { Panel } from "@/components/ui";
import { FormMessages } from "@/components/form-messages";
import { fieldClass, fieldsetClass, primaryButtonClass, secondaryButtonClass } from "@/components/styles";
import { statusLabel } from "@/lib/format";
import { requiresReason, STATUSES, transitionOptions, type Status } from "@/lib/status";

export type NoteView = {
  id: string;
  body: string;
  createdLabel: string;
  createdIso: string;
  canDelete: boolean;
};

export function RegenerateButton({ n }: { n: number }) {
  const [state, action, pending] = useActionState(regenerateFormAction, emptyFormState);
  return (
    <form action={action} className="space-y-2" aria-busy={pending}>
      <input type="hidden" name="n" value={n} />
      <FormMessages state={state} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Regenerating…" : "Regenerate summary"}
      </button>
      <p className="text-sm text-muted">Once per app per hour. The page does not call the model on its own.</p>
    </form>
  );
}

export function AdminPanel({
  n,
  status,
  blockedFrom,
  healthUrl,
  notes,
}: {
  n: number;
  status: Status;
  blockedFrom: Status | null;
  healthUrl: string | null;
  notes: NoteView[];
}) {
  return (
    <div className="space-y-4">
      <Panel title="Change status">
        <p className="text-sm text-muted">From {statusLabel(status)}.</p>
        <TransitionForm key={`${status}:${blockedFrom ?? ""}`} n={n} status={status} blockedFrom={blockedFrom} />
      </Panel>
      <Panel title="Health URL">
        <HealthUrlForm key={healthUrl ?? ""} n={n} healthUrl={healthUrl} />
      </Panel>
      <Panel title="Private notes">
        <p className="text-sm text-muted">Visible only to admins. Only the author can delete a note.</p>
        <Notes n={n} notes={notes} />
      </Panel>
    </div>
  );
}

function TransitionForm({ n, status, blockedFrom }: { n: number; status: Status; blockedFrom: Status | null }) {
  const { options, defaultTo } = transitionOptions(status, blockedFrom);
  // The parent keys this form on status, so it remounts on the new status and starts at that status's forward step.
  const [to, setTo] = useState<Status | "">(defaultTo);
  const [state, action, pending] = useActionState(transitionFormAction, emptyFormState);
  const needsReason = to !== "" && requiresReason(status, to);

  if (options.length === 0) {
    return <p className="text-sm text-muted">No status changes are available from {statusLabel(status)}.</p>;
  }

  return (
    <form action={action} className="min-w-0 space-y-3" aria-busy={pending}>
      <fieldset className={fieldsetClass}>
        <input type="hidden" name="n" value={n} />
        <label className="block space-y-1 text-sm" htmlFor={`to-${n}`}>
          <span className="font-medium">New status</span>
          <select
            id={`to-${n}`}
            name="to"
            value={to}
            required
            onChange={(event) => {
              const next = event.target.value;
              if ((STATUSES as readonly string[]).includes(next)) setTo(next as Status);
            }}
            className={fieldClass}
          >
            {defaultTo === "" ? (
              <option value="" disabled>
                Choose a status
              </option>
            ) : null}
            {options.map((option) => (
              <option key={option} value={option}>
                {statusLabel(option)}
                {requiresReason(status, option) ? " (reason required)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm" htmlFor={`reason-${n}`}>
          <span className="font-medium">
            {needsReason ? (
              <>
                Reason <span className="text-danger">(required)</span>
              </>
            ) : (
              "Reason (optional)"
            )}
          </span>
          <textarea
            id={`reason-${n}`}
            name="reason"
            required={needsReason}
            maxLength={500}
            rows={3}
            className={fieldClass}
          />
        </label>
        <p className="text-sm text-muted">
          {needsReason
            ? "A reason is required for this move. It is stored on the public history."
            : "A reason is optional. If you add one, it is stored on the public history."}
        </p>
        <FormMessages state={state} />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Updating…" : "Update status"}
        </button>
      </fieldset>
    </form>
  );
}

function HealthUrlForm({ n, healthUrl }: { n: number; healthUrl: string | null }) {
  const [state, action, pending] = useActionState(healthUrlFormAction, emptyFormState);
  return (
    <form action={action} className="min-w-0 space-y-3" aria-busy={pending}>
      <fieldset className={fieldsetClass}>
        <input type="hidden" name="n" value={n} />
        {healthUrl ? (
          <p className="break-all text-sm">
            Current URL <span className="text-muted">{healthUrl}</span>
          </p>
        ) : (
          <p className="text-sm text-muted">No override. Sync uses the subdomain health check.</p>
        )}
        <label className="block space-y-1 text-sm" htmlFor={`health-url-${n}`}>
          <span className="font-medium">Health check URL</span>
          <input
            id={`health-url-${n}`}
            name="healthUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            required
            maxLength={500}
            defaultValue={healthUrl ?? ""}
            placeholder="https://app1.breakthruventures.ai/api/health"
            className={fieldClass}
          />
        </label>
        <p className="text-sm text-muted">HTTPS only, on *.breakthruventures.ai or a known cloud host.</p>
        <FormMessages state={state} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" name="intent" value="save" disabled={pending} className={primaryButtonClass}>
            {pending ? "Working…" : "Save URL"}
          </button>
          <button
            type="submit"
            name="intent"
            value="clear"
            formNoValidate
            disabled={pending || !healthUrl}
            className={secondaryButtonClass}
          >
            Clear
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function Notes({ n, notes }: { n: number; notes: NoteView[] }) {
  return (
    <div className="space-y-4">
      {notes.length === 0 ? (
        <p className="text-sm text-muted">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <NoteItem key={note.id} n={n} note={note} />
          ))}
        </ul>
      )}
      <AddNoteForm key={notes.map((note) => note.id).join(",")} n={n} />
    </div>
  );
}

function NoteItem({ n, note }: { n: number; note: NoteView }) {
  const [state, action, pending] = useActionState(deleteNoteFormAction, emptyFormState);
  return (
    <li className="min-w-0 space-y-2 border-b border-border pb-3 last:border-b-0 last:pb-0">
      <p className="break-words whitespace-pre-wrap text-sm">{note.body}</p>
      <p className="text-xs text-muted">
        <time dateTime={note.createdIso}>{note.createdLabel}</time>
        {note.canDelete ? "" : " · Written by another admin"}
      </p>
      {note.canDelete ? (
        <form action={action} aria-busy={pending}>
          <input type="hidden" name="n" value={n} />
          <input type="hidden" name="id" value={note.id} />
          <FormMessages state={state} />
          <button type="submit" disabled={pending} className={`mt-2 ${secondaryButtonClass}`}>
            {pending ? "Deleting…" : "Delete note"}
          </button>
        </form>
      ) : null}
    </li>
  );
}

function AddNoteForm({ n }: { n: number }) {
  const [state, action, pending] = useActionState(addNoteFormAction, emptyFormState);
  return (
    <form action={action} className="min-w-0 space-y-3" aria-busy={pending}>
      <fieldset className={fieldsetClass}>
        <input type="hidden" name="n" value={n} />
        <label className="block space-y-1 text-sm" htmlFor={`note-${n}`}>
          <span className="font-medium">New note</span>
          <textarea id={`note-${n}`} name="body" required maxLength={2000} rows={3} className={fieldClass} />
        </label>
        <FormMessages state={state} />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Adding…" : "Add note"}
        </button>
      </fieldset>
    </form>
  );
}

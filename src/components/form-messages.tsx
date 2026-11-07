"use client";

import type { FormState } from "@/app/actions/form-state";

export function FormMessages({ state }: { state: FormState }) {
  return (
    <>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      ) : null}
    </>
  );
}

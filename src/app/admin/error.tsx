"use client";

import { RouteError } from "@/components/route-error";

export default function AdminError(props: { error: unknown; reset: () => void; retry: () => void }) {
  return <RouteError title="Admin failed to load" {...props} />;
}

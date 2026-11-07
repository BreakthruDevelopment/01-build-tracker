"use client";

import { RouteError } from "@/components/route-error";

export default function BoardError(props: { error: unknown; reset: () => void; retry: () => void }) {
  return <RouteError title="The board failed to load" {...props} />;
}

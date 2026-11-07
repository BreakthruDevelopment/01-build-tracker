"use client";

import { RouteError } from "@/components/route-error";

export default function AppError(props: { error: unknown; reset: () => void; retry: () => void }) {
  return <RouteError title="This app failed to load" {...props} />;
}

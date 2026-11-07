import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted">That page is not on the tracker.</p>
      <Link href="/" className="text-sm text-accent underline underline-offset-2">
        Back to the board
      </Link>
    </div>
  );
}

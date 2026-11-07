import Link from "next/link";

export default function AppNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Unknown app</h1>
      <p className="text-muted">App numbers on this board run from 1 to 30.</p>
      <Link href="/" className="text-sm text-accent underline underline-offset-2">
        Back to the board
      </Link>
    </div>
  );
}

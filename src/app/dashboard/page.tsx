import type { Metadata } from "next";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listItems } from "@/lib/items";
import { deleteItemAction } from "./actions";
import { AddItemForm, SignOutButton, SummaryPanel } from "./client";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const items = await listItems(user);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hi, {user.name}</h1>
          <p className="text-sm text-muted">
            Signed in as {user.email} · role: <span className="font-medium">{user.role}</span>
            {user.role === "admin" && (
              <>
                {" · "}
                <a href="/admin" className="underline underline-offset-2">
                  Admin
                </a>
              </>
            )}
          </p>
        </div>
        <SignOutButton />
      </div>

      <SummaryPanel />

      <section className="space-y-3">
        <h2 className="font-medium">Add an item</h2>
        <AddItemForm />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">
          {user.role === "admin" ? "All items" : "Your items"} ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet. Add your first item above.</p>
        ) : (
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="font-medium break-words">{item.title}</p>
                  {item.body && <p className="mt-1 text-sm text-muted break-words">{item.body}</p>}
                </div>
                <form action={deleteItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <button type="submit" className="text-sm text-danger hover:underline">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

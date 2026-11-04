import Link from "next/link";

const features = [
  { title: "Sign-in with roles", body: "Email and password out of the box, OIDC providers by config, admin and user roles enforced on the server." },
  { title: "Postgres", body: "Typed schema and migrations with Drizzle. Every query checks who is asking." },
  { title: "AI feature", body: "One gateway for every model call: input limits, validated JSON output, and a demo fallback." },
  { title: "Any cloud", body: "One container image, deployed to AWS, Azure, Google Cloud or Oracle Cloud with Terraform." },
];

export default function Home() {
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          A production-shaped starting point.
        </h1>
        <p className="max-w-2xl text-muted">
          Each app in the portfolio starts from this template and replaces the example
          items with its own domain and AI feature.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/sign-in"
            className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
          >
            Get started
          </Link>
          <Link
            href="/api/health"
            className="rounded-card border border-border px-4 py-2 text-sm font-medium"
          >
            Health check
          </Link>
        </div>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <div key={f.title} className="rounded-card border border-border bg-surface p-5">
            <h2 className="font-medium">{f.title}</h2>
            <p className="mt-1 text-sm text-muted">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

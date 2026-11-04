"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn, signUp } from "@/lib/auth/client";

export function SignInForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setError(null);
    setPending(true);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "");
    const result =
      mode === "sign-in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email.split("@")[0] });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That didn't work. Check your details and try again.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  const input =
    "w-full rounded-card border border-border bg-surface px-3 py-2 text-base outline-none focus:border-accent";

  return (
    <form action={onSubmit} className="space-y-4">
      {mode === "sign-up" && (
        <label className="block space-y-1 text-sm">
          <span>Name</span>
          <input name="name" autoComplete="name" className={input} />
        </label>
      )}
      <label className="block space-y-1 text-sm">
        <span>Email</span>
        <input name="email" type="email" required autoComplete="email" className={input} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          className={input}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-card bg-accent px-4 py-2 font-medium text-accent-foreground disabled:opacity-60"
      >
        {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
        className="w-full text-sm text-muted underline underline-offset-2"
      >
        {mode === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

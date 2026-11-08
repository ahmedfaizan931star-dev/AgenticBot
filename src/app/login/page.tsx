"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(params.get("error") ? "Sign-in did not complete. Try again." : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setMessage("Use at least 8 characters for the password.");
    setBusy(true);
    setMessage(null);
    const supabase = createClient();
    if (mode === "in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage("Email or password is not correct.");
      else {
        router.replace("/chat");
        router.refresh();
      }
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) setMessage("Could not create the account. Check the email and try a stronger password.");
      else if (data.session) {
        router.replace("/chat");
        router.refresh();
      } else setMessage("Check your email for a confirmation link, then sign in.");
    }
    setBusy(false);
  }

  async function google() {
    setMessage(null);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setMessage("Google sign-in is not available right now.");
  }

  return (
    <main className="login">
      <section className="login-card">
        <h1>{mode === "in" ? "Sign in to Agent Hub" : "Create your account"}</h1>
        <p className="muted">{mode === "up" ? "New accounts start with 50 free credits." : "Research, chat and work in your tabs."}</p>
        <form onSubmit={submit} className="stack">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
            />
          </label>
          {message && <div className="notice" role="alert">{message}</div>}
          <button className="btn primary" disabled={busy}>{busy ? "Please wait…" : mode === "in" ? "Sign in" : "Create account"}</button>
        </form>
        <button className="btn" onClick={() => void google()}>Continue with Google</button>
        <button className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setMessage(null); }}>
          {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

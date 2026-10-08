import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="space-y-4">
      <h1 className="h1">Sign in</h1>
      <p className="muted">Logins are created by your manager.</p>
      <LoginForm />
    </div>
  );
}

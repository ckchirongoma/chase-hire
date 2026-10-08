import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { normalisePhoneZA } from "@/lib/cv/identity";
import CvUpload from "./cv-upload";

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === "" ? null : v));
const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .transform((v) => (v === "" ? null : /^https?:\/\//i.test(v) ? v : `https://${v}`))
  .pipe(z.url().nullable());

const ProfileForm = z.object({
  full_name: optionalText(200),
  phone: optionalText(40),
  city: optionalText(100),
  province: optionalText(100),
  linkedin_url: optionalUrl,
  github_url: optionalUrl,
  portfolio_url: optionalUrl,
});

async function saveProfile(formData: FormData) {
  "use server";
  const { supabase, user } = await requireUser("/profile");
  const parsed = ProfileForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/profile?error=Please check the links you entered.");
  const { phone, ...rest } = parsed.data;
  const phone_e164 = phone ? normalisePhoneZA(phone) : null;
  if (phone && !phone_e164) redirect("/profile?error=Please enter a valid South African phone number.");
  const { error } = await supabase.from("profiles").update({ ...rest, phone_e164 }).eq("user_id", user.id);
  if (error) redirect(`/profile?error=${encodeURIComponent(error.message)}`);
  redirect("/profile?saved=1");
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { supabase, user } = await requireUser("/profile");
  const { data: consent } = await supabase.from("consents").select("id").eq("user_id", user.id).limit(1);
  if (!consent?.length) redirect("/consent");

  const [{ data: profile }, { data: cvs }] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", user.id).single(),
    supabase
      .from("cvs")
      .select("id, file_name, status, error, parsed, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const cv = cvs?.[0];
  const { error, saved } = await searchParams;

  return (
    <div className="space-y-6">
      <h1 className="h1">Your profile</h1>

      <section className="card space-y-3">
        <h2 className="h2">CV</h2>
        <p className="muted">PDF or Word (.docx), up to 5 MB. We read it with AI to pre-fill your details and prepare your screening interview.</p>
        {cv && (
          <div className="text-sm">
            <p>
              Latest: <strong>{cv.file_name}</strong> —{" "}
              {cv.status === "parsed" && <span className="badge">Read successfully</span>}
              {cv.status === "processing" && <span className="badge-warn">Processing</span>}
              {cv.status === "failed" && <span className="badge-bad">We could not read this file</span>}
            </p>
            {cv.status === "failed" && <p className="muted">Please try another file (a text-based PDF works best).</p>}
          </div>
        )}
        <CvUpload userId={user.id} />
        {cv?.status === "parsed" && (
          <p>
            <Link href="/assess/reasoning" className="btn">
              Next: Reasoning Assessment
            </Link>
          </p>
        )}
      </section>

      <form action={saveProfile} className="card grid gap-4 sm:grid-cols-2">
        <h2 className="h2 sm:col-span-2">Your details</h2>
        {[
          ["full_name", "Full name", profile?.full_name],
          ["phone", "Phone", profile?.phone_e164],
          ["city", "City", profile?.city],
          ["province", "Province", profile?.province],
          ["linkedin_url", "LinkedIn URL", profile?.linkedin_url],
          ["github_url", "GitHub URL", profile?.github_url],
          ["portfolio_url", "Portfolio URL", profile?.portfolio_url],
        ].map(([name, label, value]) => (
          <div key={name}>
            <label className="label" htmlFor={name}>{label}</label>
            <input id={name} name={name} className="input" defaultValue={value ?? ""} />
          </div>
        ))}
        {error && <p className="error sm:col-span-2">{error}</p>}
        {saved && <p className="notice sm:col-span-2">Saved.</p>}
        <div className="sm:col-span-2">
          <button className="btn">Save details</button>
        </div>
      </form>
    </div>
  );
}

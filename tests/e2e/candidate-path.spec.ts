import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { LOCAL, makeAdmin, service, uniqueEmail } from "../helpers/local";

const PASSWORD = "e2e-password-123";
const CV = path.join(__dirname, "../fixtures/cv-sample.pdf");

async function confirmationLink(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${LOCAL.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    if (messages?.length) {
      const msg = (await (await fetch(`${LOCAL.mailpit}/api/v1/message/${messages[0].ID}`)).json()) as { HTML: string; Text: string };
      const link = (msg.Text || msg.HTML).match(/https?:\/\/[^\s"<>]+verify[^\s"<>]+/)?.[0];
      if (link) return link.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No confirmation email for ${email}`);
}

async function signUpAndConfirm(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(await confirmationLink(email));
  await expect(page).toHaveURL(/\/consent/);
}

async function consentAndUploadCv(page: Page) {
  await page.getByText("I have read the notice").click();
  await page.getByText("I understand that AI is used").click();
  await page.getByText("I agree that my information may be processed outside").click();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect(page).toHaveURL(/\/profile/);
  await page.getByLabel("Upload CV").setInputFiles(CV);
  await expect(page.getByText("Read successfully")).toBeVisible({ timeout: 60_000 });
}

test("candidate signs up, uploads a CV, gets a star rating and applies; admin sees everyone with flags", async ({ browser }) => {
  // Admin (logged in once, used to release holds and to review).
  const adminEmail = uniqueEmail("e2e-admin");
  const { data } = await service().auth.admin.createUser({ email: adminEmail, password: PASSWORD, email_confirm: true });
  await makeAdmin(data.user!.id);
  const adminPage = await (await browser.newContext()).newPage();
  await adminPage.goto("/login?next=/admin/candidates");
  await adminPage.getByLabel("Email").fill(adminEmail);
  await adminPage.getByLabel("Password").fill(PASSWORD);
  await adminPage.getByRole("button", { name: "Log in" }).click();
  await expect(adminPage.getByRole("heading", { name: /Candidates/ })).toBeVisible();

  // Candidate 1: the full path through the UI.
  const email1 = uniqueEmail("e2e1");
  const page = await (await browser.newContext()).newPage();
  await signUpAndConfirm(page, email1);
  await consentAndUploadCv(page);

  await page.getByRole("link", { name: "Next: Reasoning Assessment" }).click();
  await page.getByRole("button", { name: /Start the 15-minute assessment/ }).click();
  for (let i = 1; i <= 30; i++) {
    await expect(page.getByText(`Question ${i} of 30`)).toBeVisible();
    if (i % 3 === 0) {
      await page.getByRole("button", { name: "Skip" }).click();
    } else {
      await page.keyboard.press(String(((i - 1) % 5) + 1));
      await page.keyboard.press("Enter");
    }
  }
  await expect(page.getByRole("heading", { name: "Reasoning Assessment result" })).toBeVisible();
  await expect(page.getByLabel(/out of 6 stars/)).toBeVisible();

  await page.goto("/roles/software-engineer");
  await page.getByRole("button", { name: "Apply for this role" }).click();
  await expect(page.getByText("You have applied")).toBeVisible();

  await page.goto("/me/results");
  await expect(page.getByRole("heading", { name: "Reasoning Assessment result" })).toBeVisible();
  await expect(page.getByTestId("application-software-engineer")).toBeVisible();

  // Random answers usually land below the 3-star hurdle: the application is queued for a
  // person, never rejected. The admin releases it with a written reason.
  await page.goto("/roles/software-engineer");
  if (await page.getByText("Waiting for our team to review").isVisible()) {
    await adminPage.goto("/admin/candidates");
    await adminPage.getByRole("row").filter({ hasText: email1 }).getByRole("link").first().click();
    await adminPage.locator("textarea[name=reason]").first().fill("Below hurdle, but CV shows relevant SQL and Python delivery work.");
    await adminPage.getByRole("button", { name: "Record decision" }).first().click();
    await expect(adminPage.getByText("Saved.")).toBeVisible();
  }

  // Wave 2: AI CV interview (scripted questions; JEV + grader are stubbed offline).
  await page.goto("/roles/software-engineer");
  await page.getByRole("link", { name: /Next: AI CV interview/ }).click();
  await page.getByRole("button", { name: "Start the interview" }).click();
  const answer =
    "I personally built the nightly reporting job in Python and SQL on Postgres. I chose incremental loads over full reloads, " +
    "which I measured with query timings before and after (from 40 minutes to 6). The hardest part was duplicate customers, " +
    "which I fixed with a unique key and a quarantine table. I would add alerts earlier next time.";
  for (let i = 0; i < 20; i++) {
    if (await page.getByText("Thank you, the interview is complete").isVisible()) break;
    await expect(page.getByTestId("current-question")).toBeVisible();
    await page.locator("#answer").fill(answer);
    await page.getByRole("button", { name: "Send answer" }).click();
    await expect(page.getByRole("button", { name: "Sending…" })).toHaveCount(0);
  }
  await expect(page.getByText("Thank you, the interview is complete")).toBeVisible();

  // Wave 2: timed role quiz.
  await page.getByRole("link", { name: "Go to the role quiz" }).click();
  await page.getByRole("button", { name: /Start the 12-minute quiz/ }).click();
  for (let i = 1; i <= 15; i++) {
    await expect(page.getByText(`Question ${i} of 15`)).toBeVisible();
    await page.keyboard.press(String(((i - 1) % 4) + 1));
    await page.getByRole("button", { name: "Confirm answer" }).click();
  }
  await expect(page.getByTestId("quiz-done")).toBeVisible();

  // Scores appear on the results page once grading (run right after the interview) finishes.
  await expect(async () => {
    await page.goto("/me/results");
    await expect(page.getByTestId("interview-score")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId("application-software-engineer").getByRole("heading", { name: "Role quiz" })).toBeVisible();

  // Candidate 2: a second account uploading the same CV is flagged (not blocked).
  const email2 = uniqueEmail("e2e2");
  const page2 = await (await browser.newContext()).newPage();
  await signUpAndConfirm(page2, email2);
  await consentAndUploadCv(page2);
  await expect(page2.getByRole("link", { name: "Next: Reasoning Assessment" })).toBeVisible();

  // Admin view.
  await adminPage.goto("/admin/candidates");
  await expect(adminPage.getByRole("heading", { name: /Candidates/ })).toBeVisible();

  const row1 = adminPage.getByRole("row").filter({ hasText: email1 });
  const row2 = adminPage.getByRole("row").filter({ hasText: email2 });
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();
  await expect(row1.getByText("★").first()).toBeVisible();
  await expect(row1.getByText(/SWE:/)).toBeVisible();
  await expect(row2.getByText(/dedupe/)).toBeVisible();

  // Admin sees the interview transcript/grades and quiz detail for candidate 1.
  await row1.getByRole("link").first().click();
  await expect(adminPage.getByText(/assessment detail/).first()).toBeVisible();
  await expect(adminPage.getByText(/Verification concerns|verification concerns/).first()).toBeVisible();

  await adminPage.goto("/admin/dedupe");
  await expect(adminPage.getByText("exact_file").first()).toBeVisible();
  await expect(adminPage.getByText("semantic_high").first()).toBeVisible();

  // Non-admins get a 404 for admin pages.
  await page.goto("/admin/candidates");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

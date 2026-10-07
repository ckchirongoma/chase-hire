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
  await expect(page.getByRole("cell", { name: "AI-native Software Engineer" })).toBeVisible();

  // Candidate 2: a second account uploading the same CV is flagged (not blocked).
  const email2 = uniqueEmail("e2e2");
  const page2 = await (await browser.newContext()).newPage();
  await signUpAndConfirm(page2, email2);
  await consentAndUploadCv(page2);
  await expect(page2.getByRole("link", { name: "Next: Reasoning Assessment" })).toBeVisible();

  // Admin.
  const adminEmail = uniqueEmail("e2e-admin");
  const { data } = await service().auth.admin.createUser({ email: adminEmail, password: PASSWORD, email_confirm: true });
  await makeAdmin(data.user!.id);
  const adminPage = await (await browser.newContext()).newPage();
  await adminPage.goto("/login?next=/admin/candidates");
  await adminPage.getByLabel("Email").fill(adminEmail);
  await adminPage.getByLabel("Password").fill(PASSWORD);
  await adminPage.getByRole("button", { name: "Log in" }).click();
  await expect(adminPage.getByRole("heading", { name: /Candidates/ })).toBeVisible();

  const row1 = adminPage.getByRole("row").filter({ hasText: email1 });
  const row2 = adminPage.getByRole("row").filter({ hasText: email2 });
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();
  await expect(row1.getByText("★").first()).toBeVisible();
  await expect(row1.getByText(/SWE:/)).toBeVisible();
  await expect(row2.getByText(/dedupe/)).toBeVisible();

  await adminPage.goto("/admin/dedupe");
  await expect(adminPage.getByText("exact_file").first()).toBeVisible();
  await expect(adminPage.getByText("semantic_high").first()).toBeVisible();

  // Non-admins get a 404 for admin pages.
  await page.goto("/admin/candidates");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

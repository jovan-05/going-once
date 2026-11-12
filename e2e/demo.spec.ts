import { expect, test } from "@playwright/test";

test("a judge can start a demo room and watch the bots bid", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/demo");
  await page.getByRole("button", { name: "Start a demo room" }).click();
  await expect(page).toHaveURL(/\/demo\/demo-[0-9a-f]+$/);

  const stage = page.frameLocator('iframe[title^="Stage"]');
  const phone = page.frameLocator('iframe[title^="Phone"]');
  await expect(stage.getByRole("heading", { name: "A weekend at Hollowmere tea estate" })).toBeVisible({ timeout: 30_000 });
  await expect(phone.getByRole("heading", { name: "Join the auction" })).toBeVisible();

  // Open lot 1 without a human: the five bots carry it.
  await page.getByRole("button", { name: "Start bidding now" }).click();
  await expect(page.getByRole("status").first()).toContainText(/bidding|going/, { timeout: 15_000 });
  // A bot takes the lead within the opening silence, tagged BOT on the stage.
  await expect(stage.getByText(/^paddle \d+/).first()).toBeVisible({ timeout: 40_000 });
  await expect(stage.getByText("BOT").first()).toBeVisible();

  expect(errors, errors.join("\n")).toEqual([]);
});

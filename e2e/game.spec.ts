import { expect, test, type Browser, type Page } from "@playwright/test";

const SHOTS = process.env.E2E_SHOTS ?? "test-results/screens";

async function newPlayer(browser: Browser) {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  return ctx.newPage();
}

async function enterProfileAndSound(page: Page, name: string) {
  await expect(page.getByRole("heading", { name: "Кто ты сегодня?" })).toBeVisible();
  await page.getByLabel(/Имя/).fill(name);
  await page.getByRole("button", { name: "Далее →" }).click();
  await expect(page.getByRole("heading", { name: "Проверка звука" })).toBeVisible();
  await page.getByRole("button", { name: /Разрешить микрофон/ }).click();
  await page.getByRole("button", { name: "Готово" }).click();
}

test("three players play a full round", async ({ browser }) => {
  const host = await newPlayer(browser);
  await host.goto("/");
  await host.screenshot({ path: `${SHOTS}/01-home.png` });
  await host.getByRole("button", { name: "Создать комнату" }).click();
  await expect(host).toHaveURL(/\/r\/[A-Z2-9]{5}$/);
  const code = host.url().split("/").pop()!;
  await host.screenshot({ path: `${SHOTS}/02-profile.png` });
  await enterProfileAndSound(host, "Аня");

  const others = [await newPlayer(browser), await newPlayer(browser)];
  for (const [i, p] of others.entries()) {
    await p.goto(`/r/${code}`);
    await enterProfileAndSound(p, ["Петя", "Лёша"][i]!);
  }

  await expect(host.getByText("Игроки 3/6")).toBeVisible();
  await host.getByLabel("Выбор клипа").selectOption("host");
  await host.getByLabel("Раунды").selectOption("3");
  await host.screenshot({ path: `${SHOTS}/03-lobby.png` });
  await host.getByRole("button", { name: "Начать игру" }).click();

  // pick
  await expect(host.locator(".clip-card").first()).toBeVisible();
  await host.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>(".clip-card img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  await host.screenshot({ path: `${SHOTS}/04-pick.png` });
  await host.locator(".clip-card").first().click();

  // record — everyone records one take and sends it
  const all = [host, ...others];
  await Promise.all(
    all.map(async (p, i) => {
      const rec = p.getByRole("button", { name: "● Записать" });
      await expect(rec).toBeEnabled({ timeout: 60_000 });
      if (i === 0) await p.screenshot({ path: `${SHOTS}/05-record-ready.png` });
      await rec.click();
      if (i === 0) {
        await p.waitForTimeout(6000);
        await p.screenshot({ path: `${SHOTS}/06-recording.png` });
      }
      const send = p.getByRole("button", { name: "✓ Отправить" });
      await expect(send).toBeVisible({ timeout: 60_000 });
      if (i === 0) await p.screenshot({ path: `${SHOTS}/07-review.png` });
      await send.click();
    }),
  );

  // watch — synchronized playback of 3 takes
  await expect(host.getByText(/Дубль 1 из 3/)).toBeVisible({ timeout: 30_000 });
  await host.waitForTimeout(4000);
  await host.screenshot({ path: `${SHOTS}/08-watch.png` });

  // vote — each player votes for the first take that isn't theirs
  for (const p of all) {
    await expect(p.getByRole("heading", { name: "Голосование" })).toBeVisible({ timeout: 120_000 });
  }
  await host.screenshot({ path: `${SHOTS}/09-vote.png` });
  for (const p of all) {
    await p.locator(".vote-card__main:not([disabled])").first().click();
  }

  // results
  await expect(host.getByText(/Лучший дубль раунда|никто не проголосовал/)).toBeVisible({
    timeout: 30_000,
  });
  await host.screenshot({ path: `${SHOTS}/10-results.png` });
  const total = await host.locator(".dr-score__pts").allInnerTexts();
  expect(total.join(" ")).toMatch(/[1-9]\d{2}/); // somebody scored ≥ 100

  // host fast-forwards the remaining rounds to the final screen
  for (let i = 0; i < 20; i++) {
    if (await host.getByRole("button", { name: "Играть ещё" }).isVisible()) break;
    const skip = host.getByTitle("skip");
    if (await skip.isVisible()) await skip.click().catch(() => {});
    await host.waitForTimeout(700);
  }
  await expect(host.getByRole("button", { name: "Играть ещё" })).toBeVisible();
  await host.screenshot({ path: `${SHOTS}/11-final.png` });
});

test("unknown room shows 404 with a code field", async ({ page }) => {
  await page.goto("/r/ZZZZZ");
  await expect(page.getByRole("heading", { name: "Комната не найдена" })).toBeVisible();
});

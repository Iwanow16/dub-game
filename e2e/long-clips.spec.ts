import { expect, test, type Browser, type Page } from "@playwright/test";

// Long clips (ADR-0009): scenes of a TV-series cut, and a trailer streamed whole.
// Needs the dev stack with the starter pack: ./scripts/dev.sh --seed
const SHOTS = process.env.E2E_SHOTS ?? "test-results/screens";

async function player(browser: Browser, name: string, url?: string) {
  const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
  if (url) await page.goto(url);
  else {
    await page.goto("/");
    await page.getByRole("button", { name: "Создать комнату" }).click();
  }
  await page.getByLabel(/Имя/).fill(name);
  await page.getByRole("button", { name: "Далее →" }).click();
  await page.getByRole("button", { name: /Разрешить микрофон/ }).click();
  await page.getByRole("button", { name: "Готово" }).click();
  return page;
}

/** Skips rounds (host ⏭) until a candidate card matches, then picks it. */
async function pickCard(host: Page, match: RegExp) {
  for (let round = 0; round < 7; round++) {
    await expect(host.locator(".clip-card").first()).toBeVisible({ timeout: 30_000 });
    const card = host.locator(".clip-card", { hasText: match });
    if (await card.count()) {
      await card.first().click();
      return;
    }
    // not offered this round: fast-forward to the next pick
    for (let i = 0; i < 12; i++) {
      await host
        .getByTitle("skip")
        .click()
        .catch(() => {});
      await host.waitForTimeout(400);
      if (await host.locator(".clip-card").first().isVisible()) break;
    }
  }
  throw new Error(`no candidate matching ${match}`);
}

async function videoAdvances(page: Page) {
  const video = page.locator(".stage__video");
  const t1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(1500);
  const t2 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(t2).toBeGreaterThan(t1);
}

async function setup(browser: Browser, settings: Record<string, string>) {
  const host = await player(browser, "Аня");
  const guest = await player(browser, "Петя", host.url());
  await expect(host.getByText("Игроки 2/6")).toBeVisible();
  await host.getByLabel("Выбор клипа").selectOption("host");
  await host.getByLabel("Рейтинг клипов").selectOption("16+");
  for (const [label, value] of Object.entries(settings))
    await host.getByLabel(label).selectOption(value);
  await host.getByRole("button", { name: "Начать игру" }).click();
  return { host, guest };
}

test("scene mode: a round is played on one scene of a long clip", async ({ browser }) => {
  const { host, guest } = await setup(browser, { "Длинные клипы": "scene" });
  await pickCard(host, /Сцена \d+ из \d+/);
  await host.screenshot({ path: `${SHOTS}/30-scene-record.png` });
  for (const p of [host, guest]) {
    const rec = p.getByRole("button", { name: "● Записать" });
    await expect(rec).toBeEnabled({ timeout: 60_000 });
    // a scene is short: rehearsal and two attempts are available
    await expect(p.getByRole("button", { name: "Репетиция" })).toBeVisible();
  }
  // the scene plays from its own start with its own lines
  await host.getByRole("button", { name: "Репетиция" }).click();
  await host.waitForTimeout(2500);
  await videoAdvances(host);
  await expect(host.locator(".dr-timeline__seg").first()).toBeVisible();
});

test("full mode: a 7-minute series cut is streamed, one take, synchronized watch", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { host, guest } = await setup(browser, { "Длинные клипы": "full" });
  await pickCard(host, /Коммуналка/);
  await expect(host.getByText(/Длинный клип: одна попытка/)).toBeVisible();
  await expect(host.getByRole("button", { name: "Репетиция" })).toHaveCount(0);

  await Promise.all(
    [host, guest].map(async (p, i) => {
      const rec = p.getByRole("button", { name: "● Записать" });
      await expect(rec).toBeEnabled({ timeout: 60_000 });
      await rec.click();
      await p.waitForTimeout(9000); // 3 s countdown + ~6 s of recording
      if (i === 0) {
        await videoAdvances(p); // streamed video really plays while recording
        await p.screenshot({ path: `${SHOTS}/31-full-recording.png` });
      }
      await p.getByRole("button", { name: "■ Стоп" }).click();
      const send = p.getByRole("button", { name: "✓ Отправить" });
      await expect(send).toBeVisible({ timeout: 30_000 });
      // only one attempt for long clips
      await expect(p.getByRole("button", { name: /Перезаписать/ })).toBeDisabled();
      await send.click();
    }),
  );

  await expect(host.getByText(/Дубль 1 из 2/)).toBeVisible({ timeout: 60_000 });
  await host.waitForTimeout(3000);
  await videoAdvances(host);
  // the take streams as a media element through Web Audio (no multi-MB decode)
  await host.screenshot({ path: `${SHOTS}/32-full-watch.png` });
  // both clients are at the same point of the clip (synchronized start, §13)
  const [a, b] = await Promise.all(
    [host, guest].map((p) =>
      p.locator(".stage__video").evaluate((v: HTMLVideoElement) => v.currentTime),
    ),
  );
  expect(Math.abs(a - b)).toBeLessThan(1.0);
});

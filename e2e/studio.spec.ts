import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Author flow (US-6): upload → mark up a line → export → moderate → publish.
// Needs the dev stack (./scripts/dev.sh) and STUDIO_KEY from .env.dev.
const STUDIO = process.env.E2E_STUDIO_URL ?? "http://localhost:5174";
const key = /STUDIO_KEY=(.+)/.exec(readFileSync(".env.dev", "utf8"))?.[1] ?? "";
const video = process.env.E2E_STUDIO_VIDEO ?? "";

test.skip(!video, "set E2E_STUDIO_VIDEO to a test video file");

test("author publishes a clip through Clip Studio", async ({ page }) => {
  const title = `E2E клип ${Date.now()}`;
  await page.goto(STUDIO);
  await page.getByLabel("Ключ доступа").fill(key);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("link", { name: "+ Новый клип" }).click();

  await page.getByLabel(/Видео-исходник/).setInputFiles(video);
  await page.getByLabel("Название *").fill(title);
  await page.getByLabel(/Источник \*/).fill("DubRoom E2E");
  await page.getByLabel("Лицензия *").selectOption("CC0 1.0");
  await page.getByRole("button", { name: "Загрузить и перейти к разметке" }).click();

  await expect(page.getByText(`«${title}»`)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/screens/20-studio-editor.png" });

  // add a line with the N hotkey, then fill it in
  // the headless browser can't decode H.264, so this also exercises the worker's editing proxy
  await expect(page.locator(".player video")).toBeVisible({ timeout: 120_000 });
  await page.locator(".editor__main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("n");
  await page.getByLabel("Текст (RU)").fill("Проверка связи!");
  await page.getByLabel("Конец, мс (O)").fill("2500");
  await expect(page.getByText("сохранено")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "test-results/screens/21-studio-lines.png" });

  await page.getByRole("button", { name: "6 Экспорт" }).click();
  await page.getByRole("button", { name: "Отправить на обработку" }).click();
  await expect(page.getByText(/ждёт модерации/)).toBeVisible({ timeout: 120_000 });

  await page.getByRole("link", { name: "Библиотека" }).click();
  const card = page.locator(".clip-row", { hasText: title });
  await card.getByRole("button", { name: "Проверить" }).click();
  await page.screenshot({ path: "test-results/screens/22-studio-moderation.png" });
  await page.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText("Опубликовано")).toBeVisible();

  const catalog = await (await page.request.get(`${STUDIO}/api/catalog`)).json();
  expect(catalog.clips.some((c: { title: { ru: string } }) => c.title.ru === title)).toBe(true);
});

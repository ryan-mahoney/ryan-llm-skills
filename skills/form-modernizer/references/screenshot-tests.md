# Screenshot Test Template

Write `app/test/screenshots/{formNameKebab}.screenshot.js` with these four tests — new, edit, edit-expanded, and narrow (320px):

```javascript
import { test } from "@playwright/test";
import { join } from "path";

const SCREENSHOT_DIR = join(process.cwd(), "tmp", "form-screenshots");
const HARNESS_URL = "http://localhost:3333";

test("capture {FormName} — new mode", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=new`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-new.png"),
  });
});

test("capture {FormName} — edit mode", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=edit`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-edit.png"),
  });
});

test("capture {FormName} — edit mode expanded", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=edit`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  // Expand all accordion sections
  const buttons = page.locator('[role="dialog"] button[data-headlessui-state]');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);
  // Remove fixed height to capture full content
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    dialog.style.position = "static";
    dialog.style.height = "auto";
    dialog.style.overflow = "visible";
  });
  await page.waitForTimeout(300);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-edit-expanded.png"),
  });
});

test("capture {FormName} — narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${HARNESS_URL}?mode=edit`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-narrow.png"),
  });
});
```

Set the viewport inside the narrow test rather than adding a second Playwright project — two projects would run every test twice and overwrite each other's screenshot files.

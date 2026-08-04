# Phase 2 — Form Harness & Playwright Infrastructure

One-time setup per repo. **Do NOT screenshot the live app.** The form harness renders components in isolation — no auth, no backend, pixel-accurate CSS via the project's real Tailwind build.

## 2a. Install Playwright

```bash
bun add -d @playwright/test
bunx playwright install chromium
```

## 2b. Write the screenshot config

Write `playwright.screenshot.config.js` at the repo root:

```javascript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./app/test/screenshots",
  testMatch: "*.screenshot.js",
  use: {
    baseURL: "http://localhost:3333",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "form-screenshots",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
  outputDir: "./tmp/form-screenshots",
});
```

## 2c. Write the form harness

The harness has four files in `app/test/screenshots/harness/`:

**`harness.css`** — Tailwind entry point using the project's real config:

```css
@import "tailwindcss";
@config "../../../../tailwind.config.js";
@plugin "@tailwindcss/forms";
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
```

**`mock-api.js`** — Stub API functions with realistic mock data. Export every function the form imports from `app/components/api.js`. Return plausible payloads so the form renders fully populated.

**`entry.jsx`** — React entry point that:

1. Imports `StateContext` from `app/store` and provides mock values (`pageRefresher: async () => {}`, etc.)
2. Imports the form component
3. Wraps it in `<Dialog.Root open={true}>` + `<Dialog.Portal>` + `<Dialog.Content>` (required by Radix `Dialog.Title` in `FormSidebarHeader`)
4. Reads `?mode=new` or `?mode=edit` from the URL to switch between add/edit mode with sample data
5. Renders at 480px width to match sidebar dimensions

**`serve.js`** — Bun script that:

1. Bundles `entry.jsx` via `Bun.build()` with `external: ["html2canvas"]`
2. Compiles CSS via `bunx @tailwindcss/cli -i harness.css -o tmp/form-harness/harness.css`
3. Serves an HTML page that loads the compiled CSS and JS bundle
4. Uses an `importmap` to stub `html2canvas` in the browser
5. Runs on port 3333 (configurable via `HARNESS_PORT`)

## 2d. Verify gitignore coverage

`tmp/` is already in `.gitignore`. Verify with: `grep -q "^tmp/" .gitignore`.

# Journey discovery method

How to find journey evidence in a repository you do not own the mental model of. Every source below yields seeds; the merge rules live in the SKILL.md.

## Sources by repository archetype

### Static marketing site (Next.js App Router, pre-rendered, e.g. `marketing`)

The site holds the first half of every buying and sign-up journey and no session state. Look for promises made and users launched.

| Evidence | Where (FirstWho paths) | What it yields |
|---|---|---|
| Outbound CTAs | `app/components/header/` (DesktopHeader, MobileSidebar), `app/components/footer/`, `app/constants/pricing.js` | Absolute app URLs: `/register`, `/buy/kit`, `/jobkit`. Each is a journey seam plus a goal claim. |
| Route inventory | `app/app/` directories: `jobkits`, `pricing`, `request-meeting`, `survey`, `events`, `partners`, `product-demo`, `your-resources` | Candidate journey entries: what a visitor can want here. |
| Form endpoints | page components and `constants/appRouts.js` — where forms post, including to app API hosts | The back-office journey that opens the response. |
| Content promises | `app/content/` JSON fetched by `fetch-content.sh`; `app/jobkit-content/`; `app/job-kits/` cloned by `fetch-jobkits.sh` | What the user was told before clicking — the expected side of every later seam. |
| Playwright specs | `app/e2e/` | Visited-state assertions; sometimes journey fragments. |

Hunt commands (run from the marketing project root `app/`):

```bash
# every external absolute link, with its file
rg -o "https?://[a-zA-Z0-9._/?=&%-]+" app components constants helpers | rg -v "w3.org|schema.org|fonts.|localhost" | sort -u
# form actions and API endpoints
rg -i "action=|fetch\(|axios|api/" components app --glob '!node_modules' -l
```

### Application monolith (Express + React route tables, e.g. `app`)

| Evidence | Where (FirstWho paths) | What it yields |
|---|---|---|
| Server routes | `app/routes/backend-routes.js` | Every URL, its guard, and which actor reaches it. |
| Client route tables | `app/routes/admin-react-routes.js`, `hiring-react-routes.js`, `info-react-routes.js` | Public vs admin surfaces; the `/hiring` and `/info` trees. |
| Host rewrites | `app/app.js` | Which browser URL maps to which registered route (`jobs.*`, `info.*`). |
| E2E journey catalog | `app/test/e2e/fixtures/journey-catalog.js` + `fixtures/personas.js` | Complete sourced journeys: persona, startState, acquisition, expectedOutcome, steps with `intent` and `expected`. |
| E2E implementations | `app/test/e2e/journeys/*.e2e.js` | How each step actually reaches its state. |
| Context findings | `docs/journey-context-findings.md`, `docs/journey-context-audit-plan.md` | Known seam failures; the rubric downstream evaluation uses. |
| Screen inventories | `docs/screen-inventory.md`, `docs/inventories/*` | Journey names already referenced per inventory; screens excluded from scope (public careers, info) are journey territory. |
| Product and funnel docs | `docs/relaunch-funnel.md`, `docs/multi-tenant-multi-app-marketing.md`, `docs/marketing-api-landscape.md`, repo-root `marketing-homepage-checklist.md` | Named funnels, lead conversion, attribution params. |
| Email templates | `app/email_templates/`, `py_email/` | Links that return users to the product: verification, invitations, purchase confirmation. Each is an entry point and an `identity` seam. |
| Registration path | `registerApi` in `app/controllers/authentication-controller.js` | The prospect→customer conversion, including `crmSlug`/`jobId` lead attribution. |

### Public microsites served by the app (`jobs.*`, `info.*`)

These are candidate- and reader-facing journeys owned by customer tenants. Sources: `app/routes/hiring-react-routes.js`, `app/components/hiring/`, `app/components/pub/`, and the marketing forms configured per org (`/marketing/forms`, feeding the public CTA form — see inventory finding OQ-403).

### Content and side repositories (e.g. `job-kits`, `ryan-mahoney-net`)

A content repository authors the object several journeys display. It adds no journey of its own but supplies the `content-sync` seam: identify what the app serves, what the marketing build fetches, and where slugs or shortcodes must match across both.

## Seed record shape

Write each seed exactly this way before merging:

```yaml
- seed: S-14
  actor: anonymous prospect with a job to fill
  wants: a ready-made hiring kit for a role
  starts: marketing /jobkits/<theme>/<shortcode>/ (kit detail, CTA "Buy")
  ends: app /my-kits/:shortcode with an owned kit
  crosses_repos: [marketing, app, stripe]
  evidence:
    - marketing:app/constants/pricing.js  # CTA URLs
    - app:app/test/e2e/fixtures/journey-catalog.js#GP-1
  confidence: sourced
```

`confidence` is `sourced` when a written artifact (E2E catalog, funnel doc, CTA constant) names the goal, and `inferred` when it is your reading. Every `inferred` seed must produce an open question in the registry.

## Merge decisions leave a trail

When you merge seeds or split one journey in two, write one line in the run notes: what you did, on which rule, with the seed IDs. The registry's `Ambiguous boundaries` section carries forward every decision where the two readings were both defensible. Rationale: an unrecorded merge becomes folklore, and the next run undoes it.

## The one-screen test

A candidate journey that consists of one screen is not a journey — it is a feature or a screen page. Send it to `document-screen-behavior`. A journey has at least two decision points, and in this corpus it usually has at least one repository or host crossing.

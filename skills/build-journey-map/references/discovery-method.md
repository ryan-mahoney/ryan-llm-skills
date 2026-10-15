# Journey discovery method

Find evidence in the current repositories before naming journeys. The paths and
routes below are examples, not files that every application must contain. Read
each repository's instructions and locate its actual equivalents.

## Sources by repository archetype

### Marketing site

The site often owns the beginning of a buying or sign-up journey. Look for the
promise made to a visitor and the destination of each call to action.

| Evidence | Where to look | What it yields |
|---|---|---|
| Outbound CTAs | Headers, footers, pricing components, navigation constants | App URLs such as `/register` or `/checkout`; each can be a journey seam. |
| Route inventory | Framework route directories or route configuration | Visitor goals and public entry points. |
| Form endpoints | Form actions, request helpers, API configuration | The receiving workflow and the actor who handles the response. |
| Content promises | CMS adapters, content files, build-time fetch scripts | What users were told before crossing into the application. |
| Browser tests | The configured E2E test directory | Existing journey fragments and assertions. |

Search from the repository root, restricting to source directories discovered
above when available:

```bash
rg -n 'https?://' --glob '*.{js,jsx,ts,tsx,html,md}' --glob '!**/node_modules/**'
rg -n 'action=|fetch\(|axios|api/' --glob '*.{js,jsx,ts,tsx,html}' --glob '!**/node_modules/**'
```

### Application

| Evidence | Where to look | What it yields |
|---|---|---|
| Server routes and guards | Router modules, controllers, middleware | URLs, access checks, and actors. |
| Client routes | Framework pages and route tables | Public and authenticated surfaces. |
| Host routing | Server entry point, proxy and tenant configuration | Browser hostnames that map to different internal routes. |
| E2E catalog and tests | Test configuration, persona fixtures, journey specs | Actor, starting state, goal, steps, and expected outcome. |
| Product documentation | Documentation index, permission model, screen inventories, funnel plans | Named journeys and known gaps. |
| Email templates | Mailers and notification templates | Verification, invitation, purchase, and other return entry points. |
| Registration and checkout | Route handlers and their callers | Conversion, attribution, payment, and return seams. |
| Background jobs | Job modules and their enqueueing code | Work that continues after the user leaves the request. |
| Export and integration endpoints | Controllers, jobs, API clients | Artifact handoffs and external service boundaries. |

When no journey catalog exists, use individual browser spec files as candidate
lanes. Test titles can establish an actor and goal; a spec covering infrastructure
alone is an internal lane rather than a user journey.

### Public tenant surfaces

Discover tenant hostnames and public routes from routing code and configuration.
Trace each published object from the operator who creates it to the person who
consumes it. Inspect tenant-configured forms and CTAs rather than assuming a
particular product's microsite names or route layout.

### Content and companion repositories

A content repository can supply a `content-sync` seam without adding a journey of
its own. Identify what it authors, what the application serves, what the marketing
build fetches, and which identifiers must match across systems.

## Seed record shape

Use actual repository IDs, routes, and evidence paths in each seed. This example
illustrates the shape; it is not evidence for the current product.

```yaml
- seed: S-14
  actor: anonymous visitor
  wants: a downloadable resource
  starts: marketing /resources/<slug> (CTA "Buy")
  ends: app /library/<slug> with access to the purchased resource
  crosses_repos: [marketing, app, stripe]
  evidence:
    - marketing:src/components/resource-card.tsx
    - app:tests/e2e/resource-purchase.spec.ts
  confidence: sourced
```

`confidence` is `sourced` when a written artifact names the goal, and `inferred`
when it comes from your reading. Every inferred seed produces an open question
in the registry.

## Merge decisions leave a trail

Record each merge or split in the run notes with its reason and seed IDs. Carry
ambiguous boundaries into the registry so the next run can inspect the decision.

## The one-screen test

A single-screen action is usually a feature to document with
`document-screen-behavior`. Look for the user's broader goal and decision points
before calling it a journey; do not invent a repository crossing.

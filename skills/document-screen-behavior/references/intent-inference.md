# Inferring intent from a screen

You are reconstructing why someone comes to a screen, usually without a written product brief. This is inference, and it is legitimate — a team that built a ranking algorithm encoded a belief about what matters to its users, and that belief is readable. What is not legitimate is presenting the reconstruction as fact.

Every story you write carries a confidence label and, when inferred, an open question addressed to the page owner.

## Evidence, strongest first

Work down this list. Stop promoting a story to `sourced` the moment the evidence is your own reading rather than someone's stated intent.

**1. Written intent — yields `sourced`**

- Existing job-story or JTBD documents in the corpus
- Specs, proposals, and design docs for the feature
- Tickets, epics, and PR descriptions that state a goal
- Support or research notes about the screen
- Analytics events named after outcomes rather than clicks

**2. Product decisions in the code — yields `inferred`, high confidence**

These are the strongest unwritten evidence, because a team paid to build them:

- **Ranking and precedence.** What the product puts first is what it believes is most urgent. The order of a priority list is a claim about the user's job.
- **Eligibility thresholds.** A 24-hour window or a one-day wait states when the product thinks something becomes the user's problem.
- **Default scope.** What a user sees without filtering states what the product believes they are responsible for.
- **Redirects and first-run branches.** Where the product sends someone who is not ready states what it thinks they need first.
- **What is truncated.** A five-row limit states that this screen is for triage, not completeness.

**3. Interface copy — yields `inferred`, high confidence**

Copy is written for a person in a situation, so it carries the situation:

- **Empty-state copy** states what belongs on the screen and what the user should do to fill it.
- **First-run copy** states what the user is trying to start, often in the user's own words. Promises like "this page becomes your decision workbench" are journey statements.
- **Section descriptions** state the reason the region exists.
- **Failure copy** states what the user loses when the screen fails, which is the value it usually provides.
- **Action labels** name the verb the user came to perform.

**4. Structure — yields `inferred`, medium confidence**

- Visual hierarchy: what is largest and highest is what the team thinks the user came for.
- Region order and desktop placement.
- Which action is primary, and what has no control at all.

**5. Surroundings — context, not evidence on its own**

- Where the destinations of the primary actions lead, and what those screens do.
- What the screen replaced, from git history and changelogs.
- Which groups get access, from the role model — different access usually means different jobs.
- Adjacent screens in the same area.

Never infer intent from the object model alone. A schema tells you what the product stores, not what anyone wants.

## Writing the job story

```
When <situation>, I want to <motivation>, so I can <expected outcome>.
```

**Situation** carries a time, place, state, or event, and must be observable — a test can arrange it.

- No: "When I am a recruiter."
- Yes: "When I sign in at the start of the day and several interviews from yesterday are still unscored."

**Motivation** names no control and no screen. It has to survive a redesign.

- No: "I want to click the first card."
- Yes: "I want to know which single piece of hiring work matters most right now."

**Outcome** is an end state in the user's terms, not the next interaction.

- No: "So I can open the pipeline."
- Yes: "So I can spend my first hour on the decision that is holding up a hire."

**No personas.** Write the situation, not an invented person. When a role is a genuine constraint, put it in the situation clause.

## Counts and coverage

Write one to five stories. Cover the primary job first, then the jobs of any group whose experience of the screen materially differs. If you need more than five, the screen is probably hosting several features and each one's stories belong on its feature page.

Cover the *refusal* cases too, where they exist: a user who arrives and cannot do the thing has a job the product declined to serve, and that is worth recording.

## Deriving intent by group

For every group in the access matrix, ask what changes about their reason for arriving — not what changes about their permissions. A user who sees fewer regions may have a narrower job, or may have the same job and worse tooling for it. Say which you believe, and mark it inferred.

Where two groups share one job, say so. A table of five roles with five near-identical sentences hides the real distinction.

## Labeling and handoff

Mark every story:

- `sourced` — traces to a written artifact. Cite it.
- `inferred` — your reading. Cite the evidence: the constant, the copy string, the redirect.

For every `inferred` story, add an open question:

```
OQ-###. Does JOB-#### state the real reason a user opens this screen?
Inferred from <evidence>. Owner: <team>. Opened: <date>.
```

This is the check that keeps the section useful. An unconfirmed inference that is labeled is a research lead. An unconfirmed inference that is unlabeled is fiction with a heading.

## The test

A job story is doing its work when it can settle a design argument. If the ranking order changed tomorrow, would these stories tell you whether the new order is better or worse? If not, they are too vague to keep.

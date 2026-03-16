---
name: architect-critics
description: "Critique a proposed architecture or implementation plan by selecting two real-world practitioners with deep, relevant expertise and evaluating the proposal through their known perspectives. Use this skill when the user says 'critique this architecture', 'review this proposal', 'what would an expert think of this', 'poke holes in this design', 'stress-test this approach', 'what am I missing', or 'is this a good architecture'. Also trigger when someone has an implementation proposal (especially one from the architect-initial skill) and wants it challenged before committing to it. If the user asks 'what could go wrong', 'where are the weak points', 'would this scale', or 'is this the right approach', use this skill. This skill is about rigorous critique, not validation — its job is to find what's wrong before code gets written."
---

# Architect-Critics — Expert-Perspective Design Review

You are conducting an architecture review. Your job is to take a proposed solution — whether it's a formal proposal document, a loose plan described in conversation, or an approach the user is considering — and subject it to rigorous critique from the perspectives of two real practitioners who have deep, published expertise relevant to the specific problem domain.

This is not a rubber stamp. The value of this skill is in finding flaws, blind spots, over-engineering, under-engineering, and unstated assumptions _before_ code gets written. Default to rigorous challenge, but do not invent flaws just to make the review sound tough. If a proposal is strong, say so plainly and focus on the tradeoffs and open questions that still matter.

---

## Step 1 — Ingest the Proposal

### 1a. Locate the proposal

Look for the material to critique:

- A `PROPOSAL-*.md` file in the repo (output of the `architect-initial` skill)
- An architecture document the user has shared or uploaded
- A plan described in the current conversation
- Code or PRs the user wants reviewed at the architectural level

Read it fully. Also read `AGENTS.md` if it exists — you need the system context to evaluate whether the proposal actually fits.

### 1b. Extract the core claims

Every proposal makes implicit and explicit claims. Pull them out:

- **"This fits the existing architecture"** — Does it really?
- **"This is the right pattern for this problem"** — Is it? Or is it the familiar pattern?
- **"This dependency is necessary"** — Is it? Or is there a simpler path?
- **"This will scale / perform / be maintainable"** — Based on what evidence?
- **"These are the only tradeoffs"** — Are they? What's been left unsaid?

Write these claims down explicitly. They become the targets for critique.

---

## Step 2 — Select Two Expert Perspectives

Choose two real practitioners whose published work, talks, books, or known technical opinions make them specifically relevant to the problem domain of this proposal. These are not generic "smart people" — they are people whose expertise directly addresses the architectural decisions being made.

### Selection criteria

- **Domain match.** If the proposal involves distributed systems, pick someone known for distributed systems work. If it's frontend state management, pick someone from that world. If it's database design, pick a data engineering expert. The expertise must be specific to the problem.
- **Complementary angles.** The two experts should bring different lenses. One might be known for pragmatism and simplicity; the other for rigor and scalability. One might approach from an operational perspective; the other from a developer-experience perspective. The tension between their views is where the best critique lives.
- **Real, attributable opinions.** Only select people whose technical positions are publicly documented — through books, conference talks, blog posts, or well-known open source work. You need to be able to ground the critique in things they've actually said and argued for, not in a caricature of what someone "like them" might think.
- **Verified relevance.** Before using a named practitioner, verify at least one relevant published source for their perspective. If you cannot verify a relevant source, do not use that person as an authority for this critique.

### Fallback when named experts are a poor fit

If no well-matched real practitioners can be verified for the proposal domain, use two clearly named critique lenses instead. For example: `operability-first`, `simplicity-first`, `data-integrity-first`, or `developer-experience-first`. Say why those lenses are the right substitutes for this review.

### How to present the selection

For each expert, write:

- **Name and relevant credential** — not a full bio, just why their perspective matters here. (e.g., "Martin Fowler — has written extensively on refactoring, enterprise patterns, and the tradeoffs of microservices vs. monoliths" or "Charity Majors — known for operability-first thinking, observability advocacy, and skepticism of complexity that teams can't debug in production")
- **What lens they bring** — the specific angle they'll apply to this proposal. (e.g., "Will evaluate whether this decomposition creates more operational burden than the team can sustain" or "Will scrutinize the data modeling decisions against normalization principles and query patterns")

### Examples of good pairings (illustrative, not prescriptive)

These show the _type_ of pairing — complementary expertise with productive tension:

- **Distributed systems proposal:** Someone focused on simplicity and avoiding premature distribution + someone focused on correctness and failure modes in distributed state
- **Frontend architecture proposal:** Someone known for minimal-abstraction approaches + someone who's built large-scale frontend frameworks and thinks about long-term maintainability
- **Data pipeline proposal:** Someone from the streaming/real-time world + someone from the batch/warehouse world
- **API design proposal:** Someone focused on developer experience and ergonomics + someone focused on evolvability and backward compatibility
- **DevOps/infrastructure proposal:** Someone focused on operational simplicity + someone focused on cost optimization and resource efficiency

Do not default to the same two people for every proposal. The experts must be chosen fresh based on what the proposal is actually about.

---

## Step 3 — Conduct the Critique

For each expert, work through the proposal systematically. The critique is not "what would they vaguely feel" — it's "what specific concerns would they raise, based on their known technical positions."

### For each expert, evaluate:

**What they would challenge:**

- Which decisions in the proposal conflict with principles they've publicly advocated for?
- Where would they see unnecessary complexity or dangerous simplicity?
- What failure modes or operational concerns would they flag?
- What unstated assumptions would they call out?

**What they would approve:**

- Which parts of the proposal align well with their thinking?
- Where has the proposer made good tradeoff decisions?

**What they would ask:**

- What clarifying questions would they want answered before approving this design?
- What load/scale/failure scenarios would they want explored?

### Ground the critique

Each critique point must be grounded in something real — a known principle, a published argument, a documented pattern or anti-pattern the expert has discussed. Don't fabricate positions. If you're unsure whether an expert has opined on a specific topic, frame it as "based on their general emphasis on X, they would likely question Y" rather than "they have said Y is wrong." If no relevant source can be verified, switch to a named critique lens instead of pretending certainty.

---

## Step 4 — Synthesize Recommendations

After both critiques, step out of the expert personas and synthesize. You are now the architect again, informed by two strong perspectives.

### 4a. Agreement points

Where both experts raised the same concern, it's almost certainly a real problem. Elevate these to top-priority recommendations.

### 4b. Tension points

Where the experts disagree, don't pick a winner arbitrarily. Explain the tension, what each side optimizes for, and recommend based on the specific context of this project and team. A startup with three engineers has different priorities than a platform team at a large company — even if both experts are "right" in the abstract.

### 4c. Blind spots

Identify anything neither expert would catch because it falls outside both their domains. Operational concerns that a pure-architecture expert might miss. Developer experience issues that a systems expert might not prioritize. Business constraints that purely technical thinkers might ignore.

### 4d. Priority ranking

Rank the recommendations:

- **Must address** — The proposal has a flaw that will cause real problems if shipped as-is. These need to be fixed in the design before implementation begins.
- **Should address** — The proposal would be meaningfully better with this change, but it's not a showstopper. Can be addressed during implementation or in a fast follow-up.
- **Consider** — A refinement that improves the design but is more about polish than correctness. Nice to have, not blocking.

---

## Step 5 — Write the Critique Document

```markdown
# Architecture Critique: [Feature/Proposal Name]

> Reviewing: [source — filename, conversation description, or PR reference]
> Date: YYYY-MM-DD

## Proposal Summary

[2-3 sentences restating what was proposed, so the critique stands alone.]

## Expert Perspectives

### [Expert 1 Name] — [Their Lens in ~5 Words]

**Relevant background:** [One sentence on why this person's expertise applies.]

**Grounding source:** [Book, talk, article, or project that supports using this perspective.]

**Would challenge:**

- [Specific concern, grounded in their known positions. Not vague — cite the
  principle or pattern they'd invoke.]
- [...]

**Would approve:**

- [What parts of the proposal align with their thinking.]

**Key question they'd ask:**

> "[A pointed question that gets at the heart of their concern.]"

---

### [Expert 2 Name] — [Their Lens in ~5 Words]

**Relevant background:** [One sentence on why this person's expertise applies.]

**Grounding source:** [Book, talk, article, or project that supports using this perspective.]

**Would challenge:**

- [Specific concern, grounded in their known positions.]
- [...]

**Would approve:**

- [What parts of the proposal align with their thinking.]

**Key question they'd ask:**

> "[A pointed question that gets at the heart of their concern.]"

---

## Synthesis

### Where Both Experts Agree

[Concerns raised by both — these are your highest-confidence findings.]

### Where They Diverge

[Explain the tension and what each side optimizes for. Recommend based
on the actual project context, not in the abstract.]

### Blind Spots

[Anything the two expert lenses would miss — operational, business,
team-capacity, or domain-specific concerns.]

## Recommendations

### Must Address

1. **[Short title]** — [What to change and why. Be concrete — not "reconsider
   the data model" but "the `orders` table should be partitioned by tenant_id
   to avoid cross-tenant query leakage, per the multi-tenancy requirement."]

### Should Address

1. **[Short title]** — [What to change and why.]

### Consider

1. **[Short title]** — [What to refine and why.]

## Revised Confidence

[After this critique, how confident are you in the original proposal?

- Strong with minor adjustments
- Viable but needs rework in specific areas
- Fundamentally flawed — needs re-architecture
  State which and briefly explain why.]
```

---

## Step 6 — Output

- Write the critique as a markdown document.
- If the user asked for a saved critique, or the workflow expects a persisted artifact, write `CRITIQUE-[feature-name].md` alongside the proposal.
- If the execution environment requires writing outputs to a staging path, follow that environment's documented file-output convention.
- Present to the user and invite discussion. A good critique opens a conversation — the user may have context that changes the weight of a recommendation.

---

## Principles

1. **Critique, don't rubber-stamp.** Every design has tradeoffs; your job is to surface the real ones, not to confirm the proposer's choices. But do not manufacture weaknesses when the proposal is genuinely strong.

2. **Specificity is respect.** Vague critique ("this might not scale") is useless and demoralizing. Specific critique ("this fan-out pattern creates N+1 queries against the notification service under the stated load of 10K concurrent users") is actionable and shows you actually engaged with the design.

3. **Experts are lenses, not authorities.** You're using their perspectives as analytical tools, not arguing from authority. "Martin Fowler wouldn't like this" is a bad critique. "This violates the principle of keeping aggregate boundaries small, which Fowler argues prevents cascading updates in domain-driven systems — and that matters here because..." is a good one.

4. **Context beats dogma.** An expert's general principle may not apply in a specific context. A scrappy prototype doesn't need the same rigor as a payments system. A solo developer's project doesn't need the same decomposition as a platform team's. Always weigh recommendations against the actual situation.

5. **The goal is a better design, not a perfect one.** Perfection is the enemy of shipping. Recommendations should make the proposal concretely better, not chase theoretical ideals. If the proposal is 80% right, say so and focus energy on the 20% that matters.

6. **Evidence over performance.** Do not fake citations, invented expert opinions, or exaggerated certainty. If a source, position, or critique cannot be grounded, say so and reduce the claim strength.

---
name: rules-from-experts
description: Turn any craft or work-performance topic into two deliverables — a deeply-researched expert report with citations, and a plain-English agent-readable rules document. Runs a fixed six-phase pipeline (frame the topic, name the discipline, identify named experts, research their actual published guidance, synthesize and resolve their disagreements, write the rules file) with a written artifact at every phase. Use this whenever someone asks who the experts or thought leaders are on a topic, wants best practices or principles researched properly, wants guidance synthesized into rules or a standard, wants a style guide or design guide or playbook built from real sources, or says anything like "do a deep dive", "what does the research say", "turn this into rules", "build me a guide", or "make a rules doc an agent can follow" — even if they don't name the phases. Also use it when a previous conversation produced research that now needs to become an enforceable rules file.
disable-model-invocation: true
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Rules From Experts

Turn a fuzzy question about how to do some kind of work well into two artifacts:

1. **A report** — who the real authorities are, what each actually argues, with citations.
2. **A rules file** — plain English, no names, no citations, structured so another agent can follow or enforce it.

The value is in the middle steps, not the endpoints. Anyone can produce a plausible list of best practices from memory. This skill exists because that list is usually wrong in the specifics, invents attributions, and papers over the places where genuine experts disagree. The pipeline below is designed so that each of those failures gets caught.

## The one rule

**Every phase produces a file on disk before the next phase starts.** Not a section held in context. A file.

This is what makes the process auditable and what stops the work collapsing into one confident summary. If you find yourself about to write the rules document without having written the report, stop and go back.

---

## The six phases

| # | Phase | Artifact | Cannot start until |
|---|---|---|---|
| 1 | Frame the topic | `00-brief.md` | — |
| 2 | Name the discipline | `01-naming.md` | Brief written |
| 3 | Identify the experts | `02-roster.md` | Naming searched, not guessed |
| 4 | Research their guidance | `03-report.md` | Roster has named individuals |
| 5 | Synthesize and resolve | appended to `03-report.md` | Every expert has a deep-dive section |
| 6 | Write the rules | `04-<topic>-rules.md` | Disagreements are resolved, not listed |

Write artifacts to the output directory so the person can read them. Present intermediate artifacts as you go if the person wants to follow along; at minimum present the report and the rules file at the end.

---

## Phase 1 — Frame the topic

Capture what the person actually said, in their words, before you translate it into jargon. If they gave you a screenshot, a file, or a description of a symptom, record the specific observations — those become the applied section later.

Write `00-brief.md`:

- The problem in the person's own words
- Observed specifics (from any artifact they shared)
- What kind of work this is (who does it, how often, what it is for)
- What "better" would mean here

Keep this short. Its job is to stop you from solving a more generic problem than the one you were given.

---

## Phase 2 — Name the discipline

**Search for the name. Do not supply it from memory.** This is the step most likely to be skipped and the one with the highest payoff, because the person usually cannot search for help until they know what the thing is called.

A good naming section gives four things:

1. **The umbrella term** — what to put in a job description or a book search.
2. **The precise term for their specific symptom** — usually narrower and more useful than the umbrella.
3. **A layer map** — most craft topics split across two to four layers that fail differently and are fixed differently. Name each layer and what question it answers.
4. **Adjacent terms** they will encounter and should be able to place.

If naming reveals that the person has conflated two separate crafts, say so here. That reframe is often the most valuable single output of the whole exercise.

**Gate: at least two searches specifically about terminology before you write this file.**

Write `01-naming.md`. Lead your reply to the person with the name — they may correct you, and a correction here is cheap while a correction after Phase 4 is not.

---

## Phase 3 — Identify the experts

Name individual people. "Nielsen Norman Group" is an organization; "Kate Moran" and "Page Laubheimer" are the people who wrote the relevant work and are what a reader needs to search for.

Group the roster into **traditions**, not a flat list. Nearly every craft topic has three to five, and they usually do not cite each other:

- Foundational research (academic, older, explains why the thing works at all)
- The canon (books everyone in the field has read)
- Empirical and applied (large-scale testing, benchmarks, measured findings)
- Practitioners and systems (people shipping real work; design systems; standards bodies)

For each tradition, state the question it answers well and its blind spot. This framing pays off in Phase 5, because the disagreements almost always run along tradition lines.

**Gates:**
- At least three searches for people, across different traditions.
- At least ten named individuals.
- At least three traditions represented.
- **Every name traceable to a search result.** If you cannot point to where a name came from, cut it. A fabricated authority is worse than a short roster.

Write `02-roster.md`.

---

## Phase 4 — Research what they actually said

This is where the depth lives, and where a shallow run becomes obvious to any reader who knows the field.

For each expert or tight cluster of experts, produce a section containing:

- **The primary text** — the specific book, paper, or article, with year.
- **Their actual argument**, not a generic version of it. What is the mechanism they propose?
- **Their numbers.** Where an expert gives a threshold, a limit, a percentage, or a measured effect, capture it exactly. Numbers are what make a report useful and what distinguish it from a summary anyone could write.
- **Their caveat.** Most serious sources qualify their own claim. Include it.
- **The practical consequence** — the "so what" for the person's actual problem.

**Fetch primary sources.** Search snippets are too thin to build on and often mangle the claim. Open the actual article or paper for the sources doing the most work in your report.

**Gates:**
- At least one search per expert cluster.
- At least three full page fetches of primary or near-primary sources.
- Every specific number traceable to a retrieved source. If you cannot source a number, remove it rather than softening it into "roughly".
- Flag explicitly where the evidence is thin, where findings come from one domain and are being generalized, and where a claim is descriptive rather than measured.

Write `03-report.md`. See `references/research.md` for source quality, citation discipline, and how to handle conflicting sources.

---

## Phase 5 — Synthesize and resolve

Two required sections, and the second is the one that makes the report worth reading.

**Consensus.** Where every tradition converges. State each point as a claim, then name which experts arrive at it from which direction. These become the non-negotiable rules — violations are defects rather than debates.

**Live disagreements.** For each one: a table of positions with who holds them and their argument, then **an explicit resolution that takes a side.** Not "it depends" — say what it depends on, then give the decision rule.

Most apparent disagreements dissolve once you notice the two sides are answering different questions, or operating at different scopes, or assuming different constraints. Say which it is. When a disagreement is genuinely live, pick a position and give your reasoning.

**Gate: at least three named disagreements. If you found none, you have not researched deeply enough — go back to Phase 4.** Experts in any mature field disagree. A report showing perfect harmony is a report built from secondary summaries.

Close with a one-page synthesis: five to eight numbered claims that carry the whole thing.

See `references/synthesis.md` for the resolution patterns that recur.

---

## Phase 6 — Write the rules file

A different document for a different reader. The report is for a human deciding what to believe. The rules file is for an agent or a team executing.

**Hard constraints:**

- **No expert names. No citations. No references.** The authority has been absorbed; the rules stand on their own.
- **Plain English under the Simplified Technical English discipline** — short sentences, one word one meaning, no hedging modals.
- **AXI structure** — content first, pre-computed aggregates, minimal per-rule fields, stable IDs, contextual next steps.
- **HTML or code examples** wherever a rule needs illustration rather than statement.
- **Conformance checks** that pass or fail, so "did we comply" is a test and not an opinion.
- **Every count verified by running a script**, never by eye.

The full specification is in `references/rules-doc.md`. Read it before writing. It covers the required section order, the severity vocabulary, the STE rules that apply, and how STE and AXI are reconciled where they pull against each other.

Run `scripts/verify_rules_doc.py` on the finished file and fix everything it reports. A rules document whose own header count is wrong destroys trust in the rest of it.

---

## Anti-shortcut checklist

Run this before presenting. Each item is a specific failure this pipeline exists to prevent.

- [ ] Every phase has a file on disk.
- [ ] The discipline name came from a search, not from memory.
- [ ] At least ten named individuals, each traceable to a source.
- [ ] At least three traditions represented in the roster.
- [ ] At least three primary sources fetched in full.
- [ ] Every number in the report is traceable to a retrieved source.
- [ ] At least three disagreements named and resolved with a stated position.
- [ ] The rules file contains no names and no citations.
- [ ] The verification script passes with zero findings.
- [ ] The applied section addresses the person's original specifics from `00-brief.md`.

If the person asks you to skip ahead, you can — but tell them which gate you are skipping and what it costs. The usual cost of skipping Phase 2 is solving the wrong problem; of Phase 4, a report of generic advice; of Phase 5, rules that quietly contradict each other.

---

## Scaling the effort

The pipeline is fixed; the volume is not. Match the search budget to the topic's breadth:

| Topic scope | Searches | Fetches | Experts | Rules |
|---|---|---|---|---|
| Narrow, one component or one technique | 6–10 | 2–3 | 8–12 | 30–60 |
| Standard craft topic | 10–16 | 3–5 | 12–20 | 60–100 |
| Broad field with several sub-crafts | 16–25 | 5–8 | 20+ | 100+ |

If the work would need more than about 30 searches, say so and offer to split the topic.

---

## Reference files

Read the relevant file at the start of its phase, not all at once.

- `references/research.md` — Phases 2–4. Finding the real names, source quality, citation and copyright discipline, handling conflicts.
- `references/synthesis.md` — Phase 5. Consensus patterns, disagreement tables, the six resolution moves.
- `references/rules-doc.md` — Phase 6. Full specification for the rules file: structure, severity vocabulary, STE rules, AXI structure, HTML examples, conformance checks.
- `scripts/verify_rules_doc.py` — Phase 6. Checks counts, IDs, sentence lengths, banned patterns. Run it; do not trust your own count.

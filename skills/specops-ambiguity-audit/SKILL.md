---
name: specops-ambiguity-audit
description: Audit a SpecOps analysis specification for ambiguities that would force an implementer to make undocumented judgment calls, then resolve them by spawning parallel subagents to research the legacy source code and patching the spec with concrete answers. Use this skill whenever the user mentions auditing, hardening, reviewing, or finding gaps in an analysis spec, an analysis.md file, a spec document, a SpecOps spec, or any specification derived from legacy code. Also trigger when the user asks to find unclear statements, vague behaviors, judgment calls, underspecified behavior, or implementation gaps in a spec, even if they don't use the word "ambiguity" explicitly. Trigger before generating code from a spec, after a spec-driven implementation drifted from expected behavior, or as a pre-verification pass before marking a spec verified.
---

# SpecOps Ambiguity Audit

A SpecOps analysis spec describes what legacy code does. Different implementers reading the same prose can make different judgment calls — the spec is "ambiguous" wherever it leaves room for reasonable people to disagree about intended behavior. Those gaps become bugs in the reimplementation.

This skill performs a two-phase audit on a single analysis file:

1. **Identify** every place a reimplementation would require a judgment call not answered by the spec.
2. **Resolve** each ambiguity by spawning a subagent that reads the actual legacy source code, then patch the spec with the concrete answer.

The output is a hardened spec: every behavior either documented concretely, or explicitly flagged as truly indeterminate from the source (and therefore needing a domain expert).

## Inputs

Confirm with the user before starting:

- **Analysis file path** — the spec to audit (e.g., `docs/specs/analysis/core/orchestrator.md`).
- **Source files** — the legacy code the analysis describes. These are usually listed in the spec itself or in a SpecOps orchestration doc (e.g., `docs/specops/analysis-orchestration.md`). If the spec doesn't list them, ask.
- **Working directory** — where to write the ambiguity report. Default: a sibling file `<analysis-name>.ambiguities.md` next to the spec.

If the user names the spec but not the source files, look in the spec's first few sections (Purpose, Dependencies, Integration Points) and at any project-level orchestration doc for the source file list before asking.

---

## Phase 1: Identify ambiguities

Read the analysis file end-to-end. For each section, scan for the categories below. The unifying test is:

> *"If two implementers read this and built it independently, could they produce different behavior?"*

If yes, it's ambiguous.

### Categories to look for

**Vague quantifiers and qualifiers**
- "typically", "usually", "in most cases", "sometimes", "occasionally", "often"
- "appropriate", "reasonable", "suitable", "valid", "graceful"
- "large", "small", "fast", "slow" without numbers
- "soon", "eventually", "immediately" without bounds

**Underspecified behavior**
- "validates input" — validates how? what counts as invalid? what happens on failure?
- "handles errors gracefully" — what does "gracefully" do?
- "retries on failure" — how many attempts? what backoff? which errors are retryable?
- "logs the event" — at what level? in what format? with what fields?
- "cleans up" — cleans up what, in what order, on which exit paths?
- "normalizes the value" — to what canonical form?

**Missing defaults and thresholds**
- Optional parameters mentioned without their default value
- Timeouts, intervals, limits, batch sizes referenced without numbers
- "Falls back to X" without specifying the trigger condition
- Magic constants alluded to but not given

**Implicit conditionals**
- "If the job exists" — exists where? checked how? what makes it not exist?
- "When the queue is full" — what defines full? what's the capacity?
- "After processing completes" — completes how? signaled by what?
- "Once ready" — ready by what criterion?

**Type and shape ambiguity**
- Fields described without type, optionality, or valid range
- Enumerations described as "a status" without listing the values
- Return values described as "an object" or "the result"
- "An array of items" without specifying item shape

**Concurrency and ordering gaps**
- "Processes the queue" — serially? in parallel? in what order?
- "Updates the status" — atomically? with what locking? what if it races?
- "Handles concurrent requests" — handles how? coalesced? queued? rejected?
- "Watches the directory" — debounced? polled? event-driven?

**Side-effect gaps**
- File operations without specifying create vs overwrite, atomic vs streaming, sync vs async
- Network calls without specifying timeout, retry, headers, auth
- Process operations without specifying signals, exit codes, stream handling
- Logging without specifying destination, format, redaction

**Internal contradictions**
- Section X says behavior A; section Y says behavior B. Both may be concrete, but together they're ambiguous.

**The spec's own Open Questions**
- Every entry already in the "Open Questions & Ambiguities" section is by definition an ambiguity. Include them all in the audit.

### Output of Phase 1

Write the ambiguity list to `<analysis-name>.ambiguities.md` next to the spec. Use this format:

```markdown
# Ambiguity Audit: <spec name>

- **Spec:** <full path>
- **Audited:** <date>
- **Source files referenced:** <list>

## Ambiguities

### A1
- **Section:** 4. Behavioral Contracts
- **Quote:** "Retries on transient failures with appropriate backoff."
- **Category:** Underspecified behavior + Missing thresholds
- **Question:** What classifies as "transient"? How many retry attempts? What backoff strategy and base interval?
- **Source files to investigate:** `src/core/retry.js`, `src/core/task-runner.js`

### A2
- **Section:** 3. Data Models & Structures — Status object
- **Quote:** "The status field holds the current lifecycle state."
- **Category:** Type ambiguity (enumeration not listed)
- **Question:** What are the valid values for the status field? Is there a defined transition graph?
- **Source files to investigate:** `src/config/statuses.js`, `src/core/status-writer.js`

### A3
...
```

The audit runs end-to-end without stopping for confirmation. Phase 1 produces the list; Phase 2 starts immediately. The user reviews the resulting report asynchronously — they don't need to be present while the audit runs. (If a user explicitly asks for an interactive run, you can pause here, but it's not the default.)

---

## Phase 2: Resolve via parallel subagents

For each confirmed ambiguity, spawn a subagent **in the same turn** to research the source code. Don't run them serially — launch them all together.

### Subagent prompt template

Copy this template, fill in the placeholders, and pass it to each subagent:

```
You are researching a single ambiguity in a SpecOps analysis spec by reading the legacy source code that the spec describes. Your answer will be inserted directly into the spec, so be precise.

# The spec being audited
Path: <full path to analysis file>
(Read it first to understand context, then focus on the specific section below.)

# The ambiguous statement
- Section: <section name>
- Quote: "<exact quote from spec>"
- Category: <category>
- Question: <specific question to answer>

# Source files
Read these files completely:
<list of source file paths>

You may also read files imported by these or referenced from the spec if needed to answer the question. Do not read unrelated files.

# Your task
1. Read the listed source files completely (not just grep — full read).
2. Find the code that implements the behavior in question.
3. Determine the concrete answer — exact values, exact ordering, exact conditions, exact types, exact error categories.
4. Quote the relevant lines of source code as evidence.
5. **Most questions are answerable from source.** Before giving up, follow imports transitively, read related files, and trace call chains. Only mark `still_ambiguous: true` if the answer genuinely lives outside this codebase.
6. If you must defer, classify why with one of these specific causes:
   - `closed_source_dependency` — behavior is delegated to a third-party library not in this repo
   - `caller_supplied_config` — behavior depends on a value passed in by callers, not defaulted here
   - `runtime_environment` — behavior depends on env vars, OS, file system layout the source doesn't document
   - `unstated_policy` — the source contains an apparent contradiction or magic value that encodes a policy decision with no documented rationale

# Output format
Return a JSON object only, no commentary:

{
  "ambiguity_id": "<the ID like A1>",
  "answer": "<concrete prose answer suitable for inserting into the spec, implementation-language-agnostic>",
  "spec_patch": {
    "section": "<which section of the spec to update>",
    "before": "<the original ambiguous quote>",
    "after": "<the proposed replacement prose>"
  },
  "evidence": [
    {"file": "<path>", "lines": "<line range>", "excerpt": "<relevant code>"}
  ],
  "still_ambiguous": <true | false>,
  "defer_reason": "<one of: closed_source_dependency, caller_supplied_config, runtime_environment, unstated_policy — only if still_ambiguous is true>",
  "investigated": "<brief description of files read and call chains traced — only if still_ambiguous is true>",
  "blocker": "<the specific external thing that prevents resolution — only if still_ambiguous is true>",
  "suggested_resolver": "<who or what can resolve this — only if still_ambiguous is true>",
  "suggested_next_action": "<concrete next step — only if still_ambiguous is true>"
}
```

### Running the subagents

- Use the Task tool (or whatever subagent mechanism the host environment provides) to spawn one subagent per ambiguity, all in the same turn.
- Each subagent runs independently with read access to the repository. They do not share context with each other.
- While they run, prepare the patch template — don't block.

If the host environment has no subagent capability (e.g., a vanilla chat with no Task tool), fall back to processing each ambiguity serially in the main loop, but keep the same prompt structure and output format. Note this in the audit log.

---

## Phase 3: Patch the analysis file

When all subagents return:

1. **Sort results into resolved and deferred.** Most subagents will return a concrete answer — code is rarely truly ambiguous when you have the source. The exceptions are real but uncommon, and they all have specific causes:
   - Calls into a closed-source or third-party dependency whose behavior isn't in this repo.
   - Behavior that depends on caller-supplied configuration not visible in the listed source files.
   - Behavior that depends on runtime environment (env vars, OS, file system layout) the source doesn't document.
   - Apparent contradictions in the source that encode an unstated policy decision.

   Items where `still_ambiguous: true` are **deferred**, not blocked. The audit continues. The deferred items get logged with full context (see step 4) so a human can pick them up out-of-band.

2. **Apply the spec patches.** For each resolved ambiguity, replace the original ambiguous quote with the `after` prose from the subagent. Preserve the spec's existing structure and voice — don't rewrite whole sections, just refine the specific sentences. Keep the spec implementation-language-agnostic: describe behavior, not code syntax.

3. **Anchor evidence in the patch.** Where a resolution came from specific source, the patched prose should reference it briefly — e.g., "As defined in `src/core/retry.js`, the retry policy uses exponential backoff starting at 100ms with a maximum of three attempts." This makes the next audit cheaper and gives reviewers a paper trail.

4. **Update Section 11 (Open Questions & Ambiguities) with rich context.** For each deferred item, write an entry with enough information that someone picking it up later can act without re-running the audit. Use this format:

   ```markdown
   ### OQ-<id>: <short title>

   - **Spec section affected:** <e.g., 4. Behavioral Contracts>
   - **Original quote:** "<the ambiguous statement from the spec>"
   - **Question:** <the specific question that needs answering>
   - **Why deferred:** <one of: closed-source dependency / caller-supplied config / runtime environment / unstated policy decision>
   - **What was investigated:** <files the subagent read, functions it traced>
   - **Specific blocker:** <e.g., "Behavior is delegated to `chokidar.watch()`, whose debounce semantics are not specified in this repo">
   - **Who can resolve this:** <e.g., "Anyone with chokidar API knowledge" / "The team that owns the calling code" / "Domain expert on retry policy">
   - **Suggested next action:** <e.g., "Check chokidar docs for `awaitWriteFinish` defaults" / "Ask <team> what timeout they pass" / "Decide policy and document">
   ```

   Also remove pre-existing open questions that this audit resolved. If Section 11 didn't exist (older specs), add it.

5. **Append an audit log** at the end of the analysis file:

```markdown
---

## Audit History

### <YYYY-MM-DD> — Ambiguity audit
- Ambiguities identified: <count>
- Resolved with concrete answers: <count>
- Deferred (need out-of-band resolution): <count>
- Source files re-examined: <list>
- Audit report: `<analysis-name>.ambiguities.md`
- Deferred items: see Section 11 (Open Questions) for OQ-<id> entries
```

6. **Save the ambiguity working file** alongside the spec for traceability. It records what was found, what each subagent answered, and the evidence — useful for reviewers and for diffing across audit passes.

7. **Summarize for the user.** Show:
   - How many ambiguities were found, resolved, and deferred.
   - The list of deferred items (with their OQ-ids and short titles) so the user knows what's outstanding without having to open the spec.
   - Note that deferred items are logged with full context and can be addressed out-of-band — the audit is complete regardless.

---

## Important behaviors

- **Run end-to-end without stopping.** The audit is automated. Don't pause for confirmation between phases. The user reviews the resulting report and patched spec asynchronously.
- **Code is rarely truly ambiguous.** When source is available, almost every question has a concrete answer. Treat `still_ambiguous: true` as a real but uncommon outcome with specific causes (closed-source deps, caller-supplied config, runtime environment, unstated policy). If a subagent reports it for a different reason, that's a signal the subagent didn't dig hard enough — consider re-running it with more aggressive instructions to read transitively imported files.
- **Deferred items don't block.** They get logged with full context (Section 11 + audit report) so a human can resolve them later without re-doing the audit. The audit completes regardless.
- **Don't fabricate answers.** When something genuinely depends on external context, say so concretely and move on. Don't guess.
- **Don't introduce code into prose.** The spec is implementation-language-agnostic. Resolutions describe behavior in natural language. Source line references are fine; pasted code is not.
- **Don't merge the audit report into the spec.** Keep `<spec>.ambiguities.md` as a separate persistent artifact. Future audits diff against it.
- **Re-audit is cheap.** After significant spec edits, code generation, or domain expert input on deferred items, run again. Each pass should find fewer items; convergence to zero is the verification gate.

---

## Example flow

User: "Audit `docs/specs/analysis/core/orchestrator.md` for ambiguity."

1. Read the spec. Read the source files it references (`src/core/orchestrator.js` plus anything obviously relevant).
2. Produce `docs/specs/analysis/core/orchestrator.ambiguities.md` with, say, 14 numbered ambiguities.
3. Spawn 14 subagents in one turn. Each reads the relevant source and returns JSON.
4. 13 come back resolved with concrete answers and evidence. 1 comes back `still_ambiguous` — the file watcher's debounce behavior is delegated to `chokidar`, a third-party dependency whose internals aren't in this repo.
5. Patch `orchestrator.md`: 13 in-place clarifications across sections 2, 3, 4, and 7. The 1 deferred item goes into Section 11 as `OQ-1` with full context: what was investigated, why it's deferred (closed-source dep), who can resolve it (anyone with chokidar API knowledge), and the suggested next action (check the chokidar docs for `awaitWriteFinish` defaults). Append the audit log.
6. Save the ambiguities report. Summarize for the user: "Resolved 13, deferred 1 (OQ-1: chokidar debounce behavior). The orchestrator spec is patched and the deferred item is logged for someone to resolve when convenient."

---

## Related skills and workflows

- This skill complements (does not replace) a normal spec review pass. Use both: review for accuracy, audit for ambiguity.
- For batch use across many specs, run this skill once per spec rather than trying to audit them all in one pass — the subagent fan-out is per-spec and mixing specs blurs the source-file scope each subagent should read.
- After all specs in a subsystem are audited and Open Questions are resolved by domain experts, the subsystem is ready for implementation-spec generation.

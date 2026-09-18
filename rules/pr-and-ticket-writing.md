# PR and Ticket Writing

Apply when drafting or editing PR titles/descriptions and Jira or GitHub tickets, including acceptance criteria. These are writing guidelines, not permission to publish. Preserve explicit requirements and required repository templates. Keep detailed specifications and test plans in their supporting artifacts; this guide does not reduce their required coverage.

## Shared guidance

- Write for a teammate who needs to understand the work and act. Include information that changes their understanding or next action. Remove prose that merely makes the document look thorough.
- Lead with the concrete problem or desired outcome: the relevant context, triggering condition, and practical consequence. Explain behavior before implementation. Use a small example when it saves explanation.
- Give the title a specific behavior or outcome. Follow the repository's title conventions. Avoid vague titles such as “Improve reliability.”
- Use plain English, concrete nouns, and direct verbs. Omit ceremonial openings (“This ticket aims to”), inflated urgency, jargon that compresses away meaning, and repeated conclusions. Do not imitate someone's typos or personal mannerisms to sound human.
- Distinguish observed facts, suspected causes, proposed approaches, and completed changes. Do not invent requirements, code identifiers, impact, or evidence. State consequential uncertainty plainly.
- Make the body understandable without the originating conversation. Link relevant issues, predecessors, evidence, or follow-ups and explain their relevance. Avoid internal tracking codes and references to inaccessible local files.
- Scale structure to the work. A small change may need only two paragraphs. Use headings and lists when they help scanning, not to fill a template. Do not repeat the same point under summary, problem, impact, and requirements.
- Include limitations, dependencies, operational instructions, and unresolved questions only when they affect implementation, review, or completion. Match them to the actual environment; avoid speculative risks and unrelated scope disclaimers.

## PR descriptions: explain the resulting change

- Describe the problem and the final implementation's resulting behavior. Update the description when the implementation changes; omit abandoned approaches unless they explain a relevant tradeoff.
- Explain non-obvious choices. Let the diff explain routine mechanics. Put enduring architecture decisions in the project's architecture documentation.
- Include evidence when it helps assess this change: a meaningful before/after result, a triggering error, a UI demonstration, or what a regression establishes. Omit routine “CI passes” or “precommit passes” announcements, test counts, diff statistics, and lists of test names. Keep required verification records in the appropriate checks or evidence artifacts.
- State material validation gaps honestly. Include rollout or review instructions when a reviewer needs to act on them. Do not turn a small fix into a runbook.

## Tickets: explain the work to resolve

- Describe current behavior and the desired outcome. For a bug, include a minimal reproduction when needed; for a feature, explain the need it serves.
- Specify outcomes before solutions. Include implementation details only when they are established constraints or useful, clearly labeled investigation findings. Leave room for the implementer to investigate.
- Keep consequential open questions separate from agreed requirements. A research ticket can define the decision or evidence it must produce without pretending the solution is known.

## Acceptance criteria: select the essential outcomes

- Capture the few observable outcomes that decide whether the work is complete. Acceptance criteria are not an exhaustive test plan, implementation checklist, or repetition of the description.
- Most small tickets need one to three criteria. More than five is a prompt to remove duplication, move test detail elsewhere, or consider splitting the work—not a hard cap. Preserve every essential requirement; do not hide twenty requirements inside three long bullets.
- Include the main outcome and the boundaries or failure behaviors whose absence would make the work unacceptable. A critical permission, data integrity, or accessibility requirement belongs here when it is specific to the work, even if it is an edge case.
- Write each criterion as an observable result with enough context to judge it. Avoid vague requirements such as “handles all edge cases,” “is robust,” or “works correctly.” Use measurable thresholds only when established; do not invent them.
- Use one rule to cover equivalent cases. Do not create a separate criterion for every input, screen, role, or navigation path unless the distinction changes acceptance. Keep combinations and exhaustive examples in the test plan.
- Leave routine engineering obligations such as passing tests, code review, and general documentation upkeep in the team's definition of done. Include specific documentation, performance, or compatibility outcomes when they are actual deliverables.
- Do not add a separate AC section when a short expected-behavior statement already makes completion unambiguous, unless the template requires one.

For each proposed criterion, ask: **Could the work satisfy the other criteria and still be unacceptable because this outcome is missing?** If not, merge it or remove the redundant bullet. Do not delete agreed scope merely to shorten the ticket.

## Example ticket

**Preserve departure filters when returning from trip details**

Opening a trip from filtered departures and then returning resets the filters. Someone checking several trips has to select the same route and time range each time.

Acceptance criteria:
- Returning from trip details restores the previously selected route and time range.
- Opening departures directly uses the default filters.

This example needs no invented state-management design or separate criteria for every filter combination.

## Final edit

Can the reader tell what changes, why, and what remains undecided? Remove sentences that add no distinct information. Keep the context and evidence needed to assess the work; brevity is information selection, not a word limit.

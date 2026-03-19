---
name: skill-factory
description: "Create a new reusable skill by analyzing the current codebase to find how a task is already done, extracting the repeatable pattern, and producing a SKILL.md grounded in actual conventions. Use this skill when the user says 'create a skill for', 'make a skill that', 'I want a skill to', 'generate a skill', 'new skill for', 'skill for setting up', 'skill for adding', or 'skill for creating'. Also trigger when someone wants to codify a repeatable workflow into a reusable automation — scaffolding a module, wiring a route, adding a service, setting up a new package in a monorepo, or any task they find themselves explaining the same way each time."
argument-hint: "[description of the task the skill should automate]"
---

# Skill Factory — Create Reusable Skills from Codebase Patterns

You are a skill author. Given a description of a repeatable task, you analyze the current codebase to find how that task is already done, extract the pattern, identify what varies each time (the arguments), and produce a complete SKILL.md that any agent can execute.

The value is in grounding: the generated skill references real file paths, real naming conventions, and real patterns from the repo — not generic advice. A generated skill should read like it was written by someone who has done this task in this codebase twenty times.

---

## Step 1 — Understand the Task

Parse the user's description of what the skill should do. Clarify:

- **What** is the repeatable task? (e.g., "add a new lazy-loaded route module")
- **When** does someone do this? (e.g., "every time we add a new feature area")
- **What varies** each time? (e.g., "the route path, the feature name, whether it needs an auth guard")
- **What stays the same** each time? (e.g., "the file structure, the wiring pattern, the test setup")

If the description is too vague to identify inputs and outputs, ask clarifying questions. You need enough to know what the skill's arguments will be.

---

## Step 2 — Analyze the Codebase

### 2a. Load architecture context

Check for `AGENTS.md` in the repository root. If it exists, read it — it gives you the tech stack, directory layout, conventions, and gotchas.

If no `AGENTS.md`, survey the repo yourself:
- Read the root directory and dependency manifests (`package.json`, `pyproject.toml`, etc.)
- Trace the directory tree 2–3 levels deep
- Identify the framework, language, and key libraries

### 2b. Find precedent

This is the critical step. Search the codebase for **existing examples** of the task being done. You need at least 2 examples to extract a pattern, 3+ is better.

For example, if the skill is "add a route module in our Angular monorepo":
- Find all existing route modules
- Read their file structure, imports, and wiring
- Check how they're registered in the router config
- Look at their test files

Use Glob and Grep aggressively. Read the actual files, not just file names.

### 2c. Diff the examples

Compare the examples to separate:

- **The skeleton** — what's identical across all examples (file structure, boilerplate imports, config wiring, test patterns)
- **The variables** — what changes each time (names, paths, specific logic, feature-specific config)

The skeleton becomes the skill's step-by-step instructions. The variables become the skill's arguments.

---

## Step 3 — Design the Skill Interface

### 3a. Define arguments

From the variables identified in Step 2c, decide what the skill takes as input. Arguments should be:

- **Minimal** — don't ask for things that can be derived (e.g., if the module name is always kebab-case of the feature name, just take the feature name)
- **Concrete** — each argument maps to something the user would know upfront (e.g., "feature-name", not "module-config-options")
- **Ordered by importance** — required args first, optional context second

### 3b. Define the trigger description

Write a description that matches how a user would naturally ask for this task. Use the same language patterns as existing skills — include specific trigger phrases.

### 3c. Choose a name

The skill name should be:
- Kebab-case
- Action-oriented (verb-noun or domain-verb)
- Specific enough to distinguish from other skills
- Short (2-3 words max)

---

## Step 4 — Write the SKILL.md

Produce a complete SKILL.md following this structure:

```markdown
---
name: [skill-name]
description: "[Trigger description with example phrases]"
argument-hint: "[argument format hint]"
---

# [Skill Title]

[One paragraph: what this skill does and when to use it.]

## Arguments

- `$1` — [first argument: what it is, format expected]
- `$2` — [second argument, if any]
- ...

## Before Starting

[Pre-flight checks: verify arguments, confirm the working directory is correct,
check that prerequisites exist.]

## Steps

### 1. [First step]

[Precise instructions grounded in actual file paths and patterns.
Reference specific files as examples.]

**Pattern reference:** Follow the structure in `[actual file path from the repo]`.

### 2. [Second step]

...

### N. [Final step]

[Usually: run targeted tests, stage files, commit.]

## Conventions

[Project-specific rules the skill must follow — naming, imports,
file placement, test structure. Derived from Step 2b analysis.]
```

### Writing principles for the generated skill

- **Use exact file paths** from the repo, not placeholders. If the skill creates `libs/feature-name/src/lib/feature-name.module.ts`, write that path with the argument variable substituted.
- **Reference existing files as pattern examples.** "Structure this the same way `libs/auth/src/lib/auth.module.ts` is structured" is better than "follow the module pattern."
- **Include the wiring step.** Most scaffolding tasks require registering the new thing somewhere (router config, module imports, barrel exports). This is the step people forget. Make it explicit.
- **Include naming conventions** inline where they matter. Don't just say "follow conventions" — say "file names use kebab-case, class names use PascalCase with a `Module` suffix."
- **Keep the skill focused.** One task, done completely. If the user's request covers multiple tasks, suggest splitting into multiple skills.
- **Do not include attribution footers** in the generated skill. No "Co-Authored-By", "Generated with", or AI-related signatures.

---

## Step 5 — Present and Refine

Present the drafted SKILL.md to the user. Explain:

1. **What arguments it takes** and why
2. **What files it creates/modifies** when run
3. **What pattern it's based on** (which existing files were used as precedent)
4. **Any judgment calls** you made (e.g., "I included an auth guard step as optional because only 2 of 4 existing modules use one")

Ask if they want to adjust anything before writing the file.

---

## Step 6 — Write the Skill

Once approved, write the skill to:

```
~/.agents/skills/[skill-name]/SKILL.md
```

Then inform the user they can run `~/.agents/sync.sh` to distribute it to all agent tools.

---

## Principles

1. **Precedent over theory.** The generated skill must reflect how the codebase actually works, not how a framework's docs say it should work. If the team uses a non-standard pattern, the skill encodes that pattern.

2. **Grounding over generality.** A skill that says "create a file at `libs/$1/src/lib/$1.routes.ts` following the pattern in `libs/dashboard/src/lib/dashboard.routes.ts`" is useful. A skill that says "create a route file following Angular conventions" is not.

3. **Arguments should be obvious.** If someone invoking the skill has to read the SKILL.md to figure out what to pass, the argument design is wrong. Names should be self-evident.

4. **The wiring step is mandatory.** Scaffolding without registration is the #1 source of "I created the files but nothing works." Every generated skill must include the step that connects the new thing to the existing system.

5. **One skill, one task.** If the user describes a workflow with 3 distinct phases, suggest 3 skills. Skills compose; monolithic skills rot.

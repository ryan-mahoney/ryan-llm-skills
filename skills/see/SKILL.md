---
name: see
description: Establish whether the running model can actually view images, and relay image analysis to a vision model (Codex CLI + Luna) when it cannot. Use before drawing any conclusion from a screenshot, mockup, cover, page image, or design capture — including inside other skills such as uishot, ux-auditor, and the ux-*-critique skills — and whenever the user says to use codex or Luna as the eyes. Also use when an image-viewing attempt errored or returned nothing.
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# see

The eyes contract for every skill that reasons about an image.

These skills are synced to Claude Code, Codex, Cline, Augment and OpenCode, and
the model behind them is chosen at runtime. Some of those models cannot view
images at all, and a model that cannot see usually does not announce it — it
describes the screenshot anyway. That failure is silent, which makes it the
dangerous one.

So never route on model identity. Route on a measured capability.

## 1. Establish the mode

Resolve `SEE_CHECK` to the absolute path of `scripts/see-check` in this skill
directory, and `SEE` to `scripts/codex-see`. Do not copy either into the project.

```bash
"$SEE_CHECK" mode
```

If that prints a mode other than `unknown`, use it — a verdict from the last six
hours on this same host is still good. Otherwise run the probe:

```bash
"$SEE_CHECK" start
```

It writes a PNG showing four colored squares and prints its path. View that
image, then report the colors left to right:

```bash
"$SEE_CHECK" verify red green purple yellow
```

Synonyms and prose are fine; the reading is what matters. Report only colors you
actually saw. If the image will not open, the tool errors, or you get bytes
instead of a picture, that is the answer — pass the failure through rather than
guessing. A wrong answer here is a correct outcome; a lucky guess corrupts every
visual claim downstream.

The verdict is one of three modes:

| Mode | Meaning | How you see |
|---|---|---|
| `host-vision` | you read the digits correctly | view images directly |
| `codex-relay` | you could not, and codex is installed | ask `codex-see` |
| `source-only` | you could not, and codex is missing | no visual evidence at all |

`see-check reset` discards the verdict if the model changes mid-session.

## 2. Seeing in each mode

**host-vision** — open images with the local image tool as normal. Nothing else
to do.

**codex-relay** — every visual fact comes from `codex-see`. It sends the images
plus a question to Codex CLI running the Luna vision model and prints the text
answer.

```bash
"$SEE" "<question>" <image> [<image> ...]
```

- Non-zero exit means the answer is invalid; read stderr and follow it
  (5 = codex CLI missing, 4 = codex run failed, 3 = image path wrong).
- Defaults to `gpt-5.6-luna`. Override only on request, via `CODEX_VISION_MODEL`.
- Multiple images are attached in order and referred to as "image 1", "image 2".

Ask narrow, structured questions — one broad pass, then targeted follow-ups:

```bash
# Inventory pass (one per image)
"$SEE" "Inventory this UI top to bottom: every region, its text verbatim, layout structure, colors, spacing relationships, and icons." proto.png

# Comparison pass
"$SEE" "Image 1 is the design prototype; image 2 is the implementation. List every visual difference: layout, spacing, typography, color, borders/radius/shadows, content, icons. Be exhaustive and concrete." proto.png impl.png

# Measurement / targeted follow-up
"$SEE" "In image 1, what is the approximate padding inside the card under 'Billing', and what hex color is the primary button?" impl.png

# Verification pass (after a correction)
"$SEE" "Image 1 is the prototype, image 2 the corrected implementation. Is the header now visually equivalent: same height, logo placement, nav spacing, background color? Answer yes/no per property with what you see." proto.png impl.png
```

**source-only** — you have no visual evidence. Audit from source, and say so
explicitly in the output. Do not describe what a page "looks like".

## 3. Rules that hold in every mode

1. In `codex-relay` and `source-only`, treat image bytes as opaque. Never open,
   read, or interpret a PNG/JPG directly.
2. Every visual claim traces to something: a `codex-see` answer, an image you
   actually viewed, or a source file. Say which.
3. Never strengthen a `codex-see` answer. If it says a thing cannot be
   determined, re-ask with a cropped or targeted capture, or record it as
   unresolved.
4. Declare the mode in whatever the calling skill outputs, so a reader knows how
   much the visual findings are worth.
5. Never verify a visual fix without a fresh look — a fresh capture viewed
   directly, or a fresh `codex-see` pass. Code that should work is not evidence
   that it does.

## Getting images in the first place

`see` interprets images; it does not capture them. Use the sibling `uishot`
skill to screenshot a running page or a `file://` prototype, then bring the PNG
back here.

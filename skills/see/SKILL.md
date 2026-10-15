---
name: see
description: Inspect screenshots, mockups, covers and page images through the Luna text relay, keeping image data out of the calling session. Use for visual verification and critique, including uishot and spec reviews. Probe host vision only when direct viewing is explicitly requested.
license: MIT
metadata:
  version: "2"
---

# see

Use Luna for image inspection, including when the calling model supports vision.
Images stay in a separate ephemeral relay session; the coordinator, implementation
owner and reviewer retain paths, questions and compact text findings. This keeps
image payloads out of their working context without dropping visual verification.

## 1. Use the Luna relay

Resolve `SEE` to the absolute path of `scripts/codex-see` in this skill directory.
Do not copy it into the project. Use `codex-relay` as the inspection mode; a cached
`host-vision` probe result does not override this routing policy. No vision probe
is needed for the relay.

```bash
"$SEE" "<specific visual questions>" <image> [<image> ...]
```

Only the relay opens the images. Do not read screenshots with image-capable tools,
attach them to the parent session, or print their base64 data. Pass local image
paths, the relevant criteria, and a small related set of captures to the relay.
Its output is text. Keep the full answer in an evidence artifact when needed and
return only findings, uncertainties and that artifact's path to the coordinator.

- Defaults to `gpt-5.6-luna`; change `CODEX_VISION_MODEL` only on user request.
- Images are numbered in attachment order. Name each image's state and viewport
  in the question so the answer maps back to the correct capture.
- A nonzero exit is not visual evidence (5: CLI missing; 4: relay failed;
  3: image missing). Diagnose the specific error. Do not silently switch to direct
  viewing, another model, or a source-only pass. If inspection remains unavailable,
  record `source-only` and leave required visual acceptance unresolved.

Ask for visible observations for each relevant criterion, defects and anything
that cannot be determined. Avoid an exhaustive inventory unless the task needs it.
For example:

```bash
"$SEE" "Image 1: populated member table at 1280x900. Image 2: empty state at 1280x900. For each: is the changed row visible, is its text readable without clipping, and are the expected actions distinguishable? Report observations, defects and uncertainty per image. Do not infer click behavior." populated.png empty.png
```

For comparisons, identify reference and implementation images and the properties
to compare. Re-ask with a targeted capture when a relevant detail is uncertain;
never strengthen an uncertain relay answer. Screenshots establish visible state,
not navigation, persistence, authorization or other behavior needing executable evidence.

## 2. Preserve evidence and independent review

Record the image paths, state/viewport, source revision and dirty-state applicability,
relay question, actual model selection, answer and limitations in existing evidence.
Use package-relative paths in spec artifacts. Do not claim direct host inspection
when the observations came from the relay.

An independent reviewer reuses applicable captures but asks its own Luna questions
against the reviewed criteria. It assesses the returned observations together with
code and behavioral evidence; Luna does not own the review verdict. An implementation
owner's visual summary alone does not replace the reviewer's inspection. Do not drop
images or required states merely to fit a context budget.

After a visual code correction, capture the affected state again and obtain a fresh
relay inspection. Reuse unchanged, revision-applicable captures; do not repeat a
whole browser journey merely because the inspecting session is new.

## 3. Explicit direct-viewing exception

Use host vision only when the user explicitly requests direct inspection or a
higher-priority tool contract requires it. Establish actual capability for the
current model and harness before making visual claims; another worker's cached
capability does not establish yours. This exception does not change the default
Luna route for later work.

Resolve `SEE_CHECK` to the absolute path of `scripts/see-check` in this skill directory.

```bash
"$SEE_CHECK" mode
```

Reuse a non-`unknown` verdict only if it was established for the current model and
harness. Otherwise reset it and run the probe:

```bash
"$SEE_CHECK" reset
"$SEE_CHECK" start
```

View the generated probe and report only the colors actually seen, left to right,
to `"$SEE_CHECK" verify <colors>`. If the image cannot be viewed, report that failure
rather than guessing. The capability result is `host-vision`, `codex-relay` or
`source-only`. Direct viewing requires `host-vision`; report the actual inspection
mode and unresolved limitations. Do not infer pixels from source or image bytes.

## Getting images

Use the sibling `uishot` skill or the repository's owned Playwright fixture to
capture the relevant state. Keep images as artifacts and pass their paths to Luna.
For documents, export the relevant pages to images before using the relay.

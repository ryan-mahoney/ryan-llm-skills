# Native specialized file writer

This standalone adapter sends settled owner intent, the current complete file and
an owner-produced update snippet to either authorized OpenRouter apply model. It
returns raw complete file text. It requires no changeset plan, operation selector,
source range or changeset engine. Shared imports supply only model-runtime access,
accounting, credentials, deadlines and retained request/response receipts.

The owner must prepare the instruction and snippet. Their model calls, elapsed time
and charges belong in a complete route comparison; this adapter does not create
those inputs or claim that they are free. Whole-workflow comparison still requires
the same candidate tests, terminal checks and separately declared outer review.
The separate [three-case experiment protocol](PROTOCOL.md) defines a direct DeepSeek preparation and two full-file writer arms. A separate two-call synthetic live integration
probe passed for both models; see [probe results](integration-probe-results.md).
That probe does not establish task delivery or whole-workflow performance.

## Pinned public model metadata

The dated [metadata snapshot](openrouter-metadata.json) retains selected catalog and
endpoint fields, public source URLs and response hashes. Both official model pages
specify the instruction/code/update tagged input. Benchmark and vendor accuracy
claims are excluded.

| Selector | Context tokens | Completion ceiling | Input/output USD per million tokens |
| --- | ---: | ---: | ---: |
| `openrouter/morph/morph-v3-fast` | 81,920 | 38,000 | 0.80 / 1.20 |
| `openrouter/relace/relace-apply-3` | 256,000 | 128,000 | 0.85 / 1.25 |

Sources: [OpenRouter catalog](https://openrouter.ai/api/v1/models),
[Morph endpoints](https://openrouter.ai/api/v1/models/morph/morph-v3-fast/endpoints),
[Relace endpoints](https://openrouter.ai/api/v1/models/relace/relace-apply-3/endpoints),
[Morph usage format](https://openrouter.ai/morph/morph-v3-fast),
[Relace usage format](https://openrouter.ai/relace/relace-apply-3).

Registration affects only the created runtime. It uses the existing OpenRouter
credential lookup and writes no global model configuration. Advertised caps and
prices are snapshot facts, not a current availability or billing guarantee. The
adapter explicitly sets the SDK compatibility field to emit `max_tokens`, which
both endpoint records support. It sends no tools, structured-output mode or
reasoning request. Provider routing remains OpenRouter's ordinary model routing;
no particular upstream endpoint or deployment is promised.

## API and failure behavior

```js
const writer = await createWriter({
  selector: 'openrouter/morph/morph-v3-fast',
  ledger, receiptPath, maxOutputTokens: 38000,
  maxOutputBytes: 2_000_000, maxCalls: 32, callMs: 120000,
});
const result = await writer.write({
  path: 'lib/example.mjs', allowedPaths: ['lib/example.mjs'], protectedPaths: [],
  source, sourceHash: digest(source), instruction, update,
});
```

Import `createWriter` and `digest` from `writer.mjs`. Paths are canonical relative
file names checked against an explicit allowlist and protected paths. They are
labels: the adapter reads and writes no candidate files. The source hash binds
this request, while the caller remains responsible for checking that the source
is still current before installing the returned text. New empty files may be
represented by empty source and its hash.

The existing canonical schema-1/$50 ledger must exist before creation and every
request; it is never reset. All requests use the existing Client reservation,
shared call counter when supplied, deadline, response/receipt recording and usage
settlement, including rejected outputs. Missing usage remains unknown and retains
its reservation. Errors retain their incurred accounting; they never imply zero
cost. No local or transport retry is automatic. A caller choosing retries must
budget and report that as an explicit treatment.

An explicit completion-token budget must fit the selected model ceiling. The
adapter rejects input when serialized UTF-8 bytes plus requested output tokens
and a 1,024-unit framing reserve exceed the context window. This intentionally
conservative byte proxy is not a vendor tokenizer or proof of provider acceptance.
This local guard may reject files that the actual model tokenizer would fit,
especially for Morph; refusal does not establish insufficient vendor capacity.
An explicit opt-in `contextEstimate: 'utf8-bytes-div4'` uses bytes/4 instead; it is a heuristic, not a vendor tokenizer or guarantee. The three-case experiment declares this estimate and preserves provider context rejection. Large full-file outputs may be locally ineligible even when a partial-edit route fits.
No historical 32k writer cap is silently inherited, and no chunking occurs.

Reserved prompt delimiters inside input are rejected rather than escaped or
silently altered. Non-normal stop reasons, empty/oversized output, Markdown fences
and invalid JavaScript syntax are rejected after accounting. JavaScript module
and CommonJS syntax are checked; other file types return `syntax_checked: false`.
Normal completion and syntax cannot prove that all intended content was retained,
or that the behavior is correct. There is no unchanged-range guard in this route;
using the separate apply-writer range guard would be an optional research variant
with a different eligibility contract, not a prerequisite here.

Run focused offline verification with:

```sh
node --test scripts/changeset-study/divergent/specialized-writer/writer.test.mjs
```

The wire test invokes the pinned SDK adapter with synthetic credentials and an
injected fetch returning synthetic SSE. Other fetches fail closed. These checks
establish request wiring, local fences and accounting mechanics, not actual vendor
output quality, speed, cost or task delivery.

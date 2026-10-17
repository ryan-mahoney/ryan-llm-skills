# Specialized writer integration probe

Both authorized OpenRouter models completed the same synthetic full-file update
on the first call. Deterministic AST checks confirmed both requested local edits,
exactly three exports and byte-identical preservation of the unrelated function.
No changeset plan or model input-preparation call was used.

| Model | Calls | Retries | Integration checks | SDK receipt cost USD |
| --- | ---: | ---: | --- | ---: |
| Morph V3 Fast | 1 | 0 | Pass | 0.00026880 |
| Relace Apply 3 | 1 | 0 | Pass | 0.00018845 |

Total: two calls, $0.00045725 recorded in the existing shared ledger. Costs use the
SDK's pinned prices and provider token usage, including reported cache tokens;
provider invoices were not independently verified. Morph reported 80 cache-read
tokens, priced at the ordinary input rate because no cache discount was advertised.

This confirms configured credentials, provider request wiring and one full-file
application per model. It measures neither general correctness nor comparative
performance. The fixture, settled instruction and snippet were hand-authored;
preparation time is unmeasured and does not establish free owner-input preparation.
Both calls requested 2,048 output tokens, one call maximum and a 30-second deadline.

The adapter was committed at `01e0820832439274fc83d5666d0d30fc5c30092e`.
Request/response/receipt identities, source/input/metadata/script/SDK hashes and
candidate/oracle records are retained under `specialized-writer/01-integration-probe`
relative to the declared adjacent runtime root. Sanitized details and artifact
hashes are in [integration-probe-results.json](integration-probe-results.json).
No further calls are authorized by this probe's one-use script.

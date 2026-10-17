# mechanical-migration

Use only deterministic operations. Change endpoint in src/settings.mjs from /v1/items to /v2/items. In a separate dependent operation rename the exported constant endpoint to apiEndpoint while keeping its newly changed value. Change timeout from 10 to 30. Rename old.txt to archive.txt preserving contents; remove obsolete.txt; create notes.txt with exactly "Migration ready\n" (a newline). Set config version=2 and flags.ready=true, preserving keep. Keep unrelated files unchanged.

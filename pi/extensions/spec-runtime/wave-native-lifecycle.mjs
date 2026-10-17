// Ordered native wave boot teardown (EV-13/EV-14 shared lifecycle).
//
// The wave cases live in waves.integration.test.mjs and boot through
// makeWaveFixture; this module owns the single ordered teardown callback they
// register so the test file stays within its import policy and its own size.
//
// Ordering is fixed and load-bearing:
//   1. every registered diagnostic, over a still-live fixture;
//   2. every coordinator (the real session_shutdown lifecycle);
//   3. every provider;
//   4. the fixture itself.
// A diagnostic failure is reported as a diagnostic (stderr) and never aborts
// teardown. Every other step is attempted even after a failure so one leaked
// resource cannot strand the rest, and the first non-diagnostic error is
// surfaced to the caller. The diagnostic pass runs first so a late-registered
// hook cannot observe a deleted fixture.

export function registerNativeTeardown(t, boot) {
  t.after(async () => {
    let failure = null;
    for (const diagnostic of boot.diagnostics ?? []) {
      try { await diagnostic(); } catch (error) {
        console.error(`[wave-diag] boot diagnostic failed: ${error?.message ?? String(error)}`);
      }
    }
    for (const coordinator of boot.coordinators ?? []) {
      try { await coordinator?.shutdown?.(); } catch (error) { if (!failure) failure = error; }
    }
    for (const provider of boot.providers ?? []) {
      try { await provider?.close?.(); } catch (error) { if (!failure) failure = error; }
    }
    try { await boot.fixture?.cleanup?.(); } catch (error) { if (!failure) failure = error; }
    if (failure) throw failure;
  });
  return boot;
}

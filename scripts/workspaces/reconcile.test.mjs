// Step 3 focused tests: fail-closed assignment observation.
//
// Pure transition fixtures supply observations directly to classify.
// Observation-composition cases use temporary roots and substitute only the
// final OS/tmux command boundary with realistic replies (or the installed
// inspectProcess where the real boundary is the point). Nothing here writes
// to a real storage root, signals an agent or mutates the default tmux
// server.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProcess } from "../spec-observe/process-identity.mjs";
import { classify, observeAssignment, reconcileAssignment } from "./reconcile.mjs";
import { probeSession } from "./tmux.mjs";

const FLAT_START = "Thu Jan  1 00:00:00 1970";

function baseRecord(overrides = {}) {
  return {
    assignment_id: randomUUID(),
    state: "launching",
    created_at: new Date().toISOString(),
    tmux_socket: "/tmp/adj4-reconcile-missing.sock",
    tmux_session: `adj-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    pi_session_dir: null,
    pane_id: null,
    pi_identity: null,
    launcher_identity: null,
    ...overrides,
  };
}

function observations(overrides = {}) {
  return {
    launcher: { status: "unknown" },
    terminal: { status: "unknown" },
    pi: { status: "unknown" },
    uuidProcesses: { status: "unknown" },
    session: { status: "missing" },
    ...overrides,
  };
}

function note(result) {
  return result.attention.join("; ");
}

const okRun = (stdout) => ({ ok: true, code: 0, stdout, stderr: "" });
const exitOneRun = () => ({ ok: false, code: 1, stdout: "", stderr: "no session", message: "no session" });

// Realistic tmux command-boundary replies for probeSession's read-only queue.
function tmuxRunFor({ tag, pane, absent = false, reachable = true } = {}) {
  return async (socketPath, args) => {
    const command = args[0];
    if (command === "has-session") return absent ? exitOneRun() : okRun("");
    if (command === "list-clients") return reachable ? okRun("") : exitOneRun();
    if (command === "show-options") {
      return tag === undefined ? exitOneRun() : okRun(`${tag}\n`);
    }
    if (command === "display-message") {
      return pane === undefined ? exitOneRun() : okRun(`${pane.paneId} ${pane.panePid}\n`);
    }
    return exitOneRun();
  };
}

const deadInspect = (pid) => ({ state: "dead", pid });

function compositionProbes(overrides = {}) {
  return {
    inspect: deadInspect,
    tmuxRun: tmuxRunFor({ absent: true, reachable: true }),
    psRun: async () => ({ stdout: "", complete: false }),
    ...overrides,
  };
}

test("assignment observation: alive launcher with absent terminal stays launching and old age only adds attention", () => {
  const launcherIdentity = { pid: process.pid, started_at: FLAT_START };
  const record = baseRecord({ launcher_identity: launcherIdentity });

  const alive = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { status: "absent" },
    now: Date.now(),
  }));
  assert.equal(alive.state, "launching");
  assert.equal(alive.gone, false);
  assert.equal(alive.piIdentity, null);
  assert.match(note(alive), /no Pi process identity was recorded/);
  assert.doesNotMatch(note(alive), /60 seconds/);

  const aged = classify(
    baseRecord({
      created_at: new Date(Date.now() - 120000).toISOString(),
      launcher_identity: launcherIdentity,
    }),
    observations({
      launcher: { status: "alive", identity: launcherIdentity },
      terminal: { status: "absent" },
      now: Date.now(),
    }),
  );
  assert.equal(aged.state, "launching");
  assert.equal(aged.gone, false);
  assert.match(note(aged), /60 seconds/);

  // An unknown launcher is ambiguous: the reservation moves to
  // launch_unknown and still never releases.
  const ambiguous = classify(record, observations({ launcher: { status: "unknown" } }));
  assert.equal(ambiguous.state, "launch_unknown");
  assert.equal(ambiguous.gone, false);
  assert.match(note(ambiguous), /launcher identity observation is unknown/);

  // A dead launcher with incomplete evidence is interrupted, not failed.
  const interrupted = classify(record, observations({ launcher: { status: "dead" } }));
  assert.equal(interrupted.state, "launch_unknown");
  assert.equal(interrupted.gone, false);
});

test("assignment observation: exact pane and Pi identity promote launching and launch_unknown to live", () => {
  const savedPi = { pid: 4242, started_at: FLAT_START };
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const record = baseRecord({ pane_id: "%7", pi_identity: savedPi, launcher_identity: launcherIdentity });
  const terminal = {
    status: "present",
    assignment_id: record.assignment_id,
    pane_id: "%7",
    pid: 4242,
  };
  const liveObservations = observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal,
    pi: { status: "alive", identity: savedPi },
  });

  const live = classify(record, liveObservations);
  assert.equal(live.state, "live");
  assert.equal(live.gone, false);
  assert.deepEqual(live.piIdentity, savedPi);

  const saved = classify({ ...record, state: "launch_unknown" }, liveObservations);
  assert.equal(saved.state, "live");

  // Exact UUID, exact saved pane and exact saved start are all required.
  const wrongUuid = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { ...terminal, assignment_id: randomUUID() },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(wrongUuid.state, "launching");
  assert.equal(wrongUuid.gone, false);

  const wrongPane = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { ...terminal, pane_id: "%8" },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(wrongPane.state, "launching");
  assert.deepEqual(wrongPane.piIdentity, savedPi);

  const wrongPanePid = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { ...terminal, pid: 9999 },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(wrongPanePid.state, "launching");
  assert.match(note(wrongPanePid), /without the exact recorded terminal/);

  // A live PID with a different start is a reused PID, not the recorded Pi.
  const reused = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal,
    pi: { status: "alive", identity: { pid: 4242, started_at: "Thu Jan  2 00:00:00 1970" } },
  }));
  assert.equal(reused.state, "launching");
  assert.equal(reused.piIdentity, null);
  assert.match(note(reused), /start no longer matches/);
});

test("assignment observation: confirmed gone requires dead launcher, absent terminal and Pi absence", () => {
  const savedPi = { pid: 4242, started_at: FLAT_START };
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const record = baseRecord({ pi_identity: savedPi, launcher_identity: launcherIdentity });
  const goneObservations = observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "dead" },
  });

  const failed = classify(record, goneObservations);
  assert.equal(failed.state, "launch_failed");
  assert.equal(failed.gone, true);

  const ended = classify({ ...record, state: "live" }, goneObservations);
  assert.equal(ended.state, "ended");
  assert.equal(ended.gone, true);

  const unknownPi = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "unknown", reason: "ETIMEDOUT" },
  }));
  assert.equal(unknownPi.state, "launch_unknown");
  assert.equal(unknownPi.gone, false);

  // A live launcher always prevents failure even when the Pi is dead.
  const liveLauncher = classify(record, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { status: "absent" },
    pi: { status: "dead" },
  }));
  assert.equal(liveLauncher.state, "launching");
  assert.equal(liveLauncher.gone, false);

  // Matching Pi alive without the exact terminal stays attention/reservation.
  const matchingWithoutTerminal = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(matchingWithoutTerminal.state, "launch_unknown");
  assert.equal(matchingWithoutTerminal.gone, false);
  assert.match(note(matchingWithoutTerminal), /without the exact recorded terminal/);

  // A launch_unknown record promotes on evidence or fails only after gone.
  const promoted = classify({ ...record, state: "launch_unknown" }, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { status: "present", assignment_id: record.assignment_id, pane_id: "%7", pid: 4242 },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(promoted.state, "live");
  const failedFromUnknown = classify({ ...record, state: "launch_unknown" }, goneObservations);
  assert.equal(failedFromUnknown.state, "launch_failed");

  // Without a saved Pi identity, only a complete listing can prove gone.
  const noIdentity = baseRecord({ launcher_identity: launcherIdentity });
  const completeAbsence = classify(noIdentity, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    uuidProcesses: { status: "absent" },
  }));
  assert.equal(completeAbsence.state, "launch_failed");
  assert.equal(completeAbsence.gone, true);

  const candidatePresent = classify(noIdentity, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    uuidProcesses: { status: "present" },
  }));
  assert.equal(candidatePresent.state, "launch_unknown");
  assert.equal(candidatePresent.gone, false);
  assert.match(note(candidatePresent), /candidate for the assignment UUID/);

  const incomplete = classify(noIdentity, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    uuidProcesses: { status: "unknown" },
  }));
  assert.equal(incomplete.state, "launch_unknown");
  assert.equal(incomplete.gone, false);
  assert.match(note(incomplete), /UUID absence cannot be confirmed/);

  // Positive process-listing evidence contradicts gone, even with a dead
  // saved Pi identity.
  const contradictory = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "dead" },
    uuidProcesses: { status: "present" },
  }));
  assert.equal(contradictory.state, "launch_unknown");
  assert.equal(contradictory.gone, false);
  assert.match(note(contradictory), /candidate for the assignment UUID/);

  // An unknown launcher blocks gone even with a dead Pi and complete absence.
  const unknownLauncher = classify(record, observations({
    launcher: { status: "unknown" },
    terminal: { status: "absent" },
    pi: { status: "dead" },
    uuidProcesses: { status: "absent" },
  }));
  assert.equal(unknownLauncher.state, "launch_unknown");
  assert.equal(unknownLauncher.gone, false);

  // Terminal records never revive.
  const terminal = classify({ ...record, state: "ended" }, observations({
    launcher: { status: "alive", identity: launcherIdentity },
    terminal: { status: "present", assignment_id: record.assignment_id, pane_id: "%7", pid: 4242 },
    pi: { status: "alive", identity: savedPi },
  }));
  assert.equal(terminal.state, "ended");
});

test("assignment observation: tmux probe requires full UUID and saved pane with unreachable server unknown", async () => {
  const record = baseRecord({ pane_id: "%3" });
  const present = await probeSession(record, {
    run: tmuxRunFor({ tag: record.assignment_id, pane: { paneId: "%3", panePid: 4242 } }),
  });
  assert.deepEqual(present, {
    status: "present",
    assignment_id: record.assignment_id,
    pane_id: "%3",
    pid: 4242,
  });

  const noSavedPane = await probeSession({ ...record, pane_id: null }, {
    run: tmuxRunFor({ tag: record.assignment_id, pane: { paneId: "%9", panePid: 1 } }),
  });
  assert.equal(noSavedPane.status, "present");
  assert.equal(noSavedPane.pane_id, "%9");

  // A missing or mismatched UUID option is unknown, never foreign adoption.
  assert.equal(
    (await probeSession(record, { run: tmuxRunFor({ pane: { paneId: "%3", panePid: 4242 } }) })).status,
    "unknown",
  );
  assert.equal(
    (await probeSession(record, {
      run: tmuxRunFor({ tag: randomUUID(), pane: { paneId: "%3", panePid: 4242 } }),
    })).status,
    "unknown",
  );
  assert.equal(
    (await probeSession(record, {
      run: tmuxRunFor({ tag: record.assignment_id, pane: { paneId: "%4", panePid: 4242 } }),
    })).status,
    "unknown",
  );

  // Reachable-server has-session exit 1 is the only confirmed absence; an
  // unreachable server or a throwing transport is unknown.
  assert.deepEqual(
    await probeSession(record, { run: tmuxRunFor({ absent: true, reachable: true }) }),
    { status: "absent" },
  );
  assert.equal(
    (await probeSession(record, { run: tmuxRunFor({ absent: true, reachable: false }) })).status,
    "unknown",
  );
  assert.equal(
    (await probeSession(record, { run: async () => { throw new Error("transport failed"); } })).status,
    "unknown",
  );
  assert.equal((await probeSession(baseRecord({ tmux_socket: null }), { run: tmuxRunFor() })).status, "unknown");
});

test("assignment observation: ps candidate listings never prove UUID absence by default", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj4-reconcile-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const record = baseRecord({ launcher_identity: launcherIdentity });

  const candidate = await observeAssignment(record, compositionProbes({
    psRun: async () => `4242 /usr/bin/node --session-id ${record.assignment_id}\n`,
  }));
  assert.equal(candidate.state, "launch_unknown");
  assert.equal(candidate.gone, false);
  assert.match(note(candidate), /candidate for the assignment UUID/);

  for (const psRun of [
    async () => "4242 /usr/bin/node --session-id other-assignment\n",
    async () => { throw Object.assign(new Error("truncated"), { code: "ENOBUFS" }); },
    async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); },
  ]) {
    const result = await observeAssignment(record, compositionProbes({ psRun }));
    assert.equal(result.state, "launch_unknown");
    assert.equal(result.gone, false);
    assert.match(note(result), /UUID absence cannot be confirmed/);
  }

  // A caller with a complete platform listing can prove absence; the
  // default probe never sets complete.
  const complete = await observeAssignment(record, compositionProbes({
    psRun: async () => ({ stdout: "4242 /usr/bin/node\n", complete: true }),
  }));
  assert.equal(complete.state, "launch_failed");
  assert.equal(complete.gone, true);

  // With a saved Pi identity, a dead process is enough even if ps is unknown.
  const withIdentity = baseRecord({
    launcher_identity: launcherIdentity,
    pi_identity: { pid: 4242, started_at: FLAT_START },
  });
  const savedDead = await observeAssignment(withIdentity, compositionProbes({
    inspect: (pid) => ({ state: "dead", pid }),
  }));
  assert.equal(savedDead.state, "launch_failed");
  assert.equal(savedDead.gone, true);

  // Reused recorded PIDs change both the launcher and Pi starts: both are
  // dead, so the absent terminal plus the dead Pi identity confirms gone.
  const reused = await observeAssignment(withIdentity, compositionProbes({
    inspect: (pid) => ({ state: "alive", pid, started_at: "Thu Jan  2 00:00:00 1970" }),
  }));
  assert.equal(reused.state, "launch_failed");
  assert.equal(reused.gone, true);
  assert.match(note(reused), /confirmed dead/);

  // Composition uses only the real classify implementation.
  assert.equal(reconcileAssignment, observeAssignment);
});

test("assignment observation: session discovery distinguishes missing, matching, malformed, nonregular and duplicate headers", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj4-reconcile-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };

  async function observeWithSessionDir(id, sessionDir) {
    return observeAssignment(
      baseRecord({ assignment_id: id, launcher_identity: launcherIdentity, pi_session_dir: sessionDir }),
      compositionProbes(),
    );
  }

  const idA = randomUUID();
  const missingResult = await observeWithSessionDir(idA, join(root, "missing", idA));
  assert.equal(missingResult.sessionFile, null);
  assert.doesNotMatch(note(missingResult), /session file/);

  const idB = randomUUID();
  const readableDir = join(root, "readable");
  await mkdir(readableDir, { recursive: true });
  const readableFile = join(readableDir, `2026-01-01T00-00-00-000Z_${idB}.jsonl`);
  await writeFile(readableFile, `${JSON.stringify({ type: "session", id: idB, version: 3 })}\nalpha\n`);
  const readableResult = await observeWithSessionDir(idB, readableDir);
  assert.equal(readableResult.sessionFile, readableFile);
  assert.doesNotMatch(note(readableResult), /session file/);

  const idC = randomUUID();
  const malformedDir = join(root, "malformed");
  await mkdir(malformedDir, { recursive: true });
  await writeFile(
    join(malformedDir, `2026-01-01T00-00-00-000Z_${idC}.jsonl`),
    "{ not valid json\n",
  );
  const malformedResult = await observeWithSessionDir(idC, malformedDir);
  assert.equal(malformedResult.sessionFile, null);
  assert.match(note(malformedResult), /session file candidate is unreadable or malformed/);

  const idD = randomUUID();
  const wrongIdDir = join(root, "wrong-id");
  await mkdir(wrongIdDir, { recursive: true });
  await writeFile(
    join(wrongIdDir, `2026-01-01T00-00-00-000Z_${idD}.jsonl`),
    `${JSON.stringify({ type: "session", id: randomUUID(), version: 3 })}\n`,
  );
  const wrongIdResult = await observeWithSessionDir(idD, wrongIdDir);
  assert.equal(wrongIdResult.sessionFile, null);
  assert.match(note(wrongIdResult), /session file candidate is unreadable or malformed/);

  const idE = randomUUID();
  const duplicateDir = join(root, "duplicate");
  await mkdir(duplicateDir, { recursive: true });
  for (const prefix of ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z"]) {
    await writeFile(
      join(duplicateDir, `${prefix}_${idE}.jsonl`),
      `${JSON.stringify({ type: "session", id: idE, version: 3 })}\n`,
    );
  }
  const duplicateResult = await observeWithSessionDir(idE, duplicateDir);
  assert.equal(duplicateResult.sessionFile, null);
  assert.match(note(duplicateResult), /multiple Pi session files match assignment/);

  const idF = randomUUID();
  const validAndMalformedDir = join(root, "valid-and-malformed");
  await mkdir(validAndMalformedDir, { recursive: true });
  await writeFile(
    join(validAndMalformedDir, `2026-01-01T00-00-00-000Z_${idF}.jsonl`),
    `${JSON.stringify({ type: "session", id: idF, version: 3 })}\n`,
  );
  await writeFile(join(validAndMalformedDir, `2026-01-02T00-00-00-000Z_${idF}.jsonl`), "not json\n");
  const ambiguousRead = await observeWithSessionDir(idF, validAndMalformedDir);
  assert.equal(ambiguousRead.sessionFile, null);
  assert.match(note(ambiguousRead), /session file candidate is unreadable or malformed/);

  const idG = randomUUID();
  const nonregularDir = join(root, "nonregular");
  await mkdir(join(nonregularDir, `2026-01-01T00-00-00-000Z_${idG}.jsonl`), { recursive: true });
  const nonregularResult = await observeWithSessionDir(idG, nonregularDir);
  assert.equal(nonregularResult.sessionFile, null);
  assert.match(note(nonregularResult), /session file candidate is unreadable or malformed/);

  const idH = randomUUID();
  const symlinkDir = join(root, "symlink");
  await mkdir(symlinkDir, { recursive: true });
  const target = join(root, "elsewhere.jsonl");
  await writeFile(target, `${JSON.stringify({ type: "session", id: idH, version: 3 })}\n`);
  await symlink(target, join(symlinkDir, `2026-01-01T00-00-00-000Z_${idH}.jsonl`));
  const symlinkResult = await observeWithSessionDir(idH, symlinkDir);
  assert.equal(symlinkResult.sessionFile, null);
  assert.match(note(symlinkResult), /session file candidate is unreadable or malformed/);

  const idI = randomUUID();
  const unrelatedDir = join(root, "unrelated");
  await mkdir(unrelatedDir, { recursive: true });
  await writeFile(
    join(unrelatedDir, `2026-01-01T00-00-00-000Z_${randomUUID()}.jsonl`),
    `${JSON.stringify({ type: "session", id: randomUUID(), version: 3 })}\n`,
  );
  const unrelatedResult = await observeWithSessionDir(idI, unrelatedDir);
  assert.equal(unrelatedResult.sessionFile, null);
  assert.doesNotMatch(note(unrelatedResult), /session file/);
});

test("assignment observation: installed inspectProcess and default read-only composition hold a live launcher reservation", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj4-reconcile-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const observed = inspectProcess(process.pid);
  assert.equal(observed.state, "alive");
  assert.equal(observed.pid, process.pid);
  assert.ok(observed.started_at.length > 0);

  const record = baseRecord({
    launcher_identity: { pid: observed.pid, started_at: observed.started_at },
    tmux_socket: join(root, "absent.sock"),
    pi_session_dir: join(root, "sessions", randomUUID()),
  });
  const before = (await readdir(root)).sort();
  const result = await observeAssignment(record);
  assert.equal(result.state, "launching");
  assert.equal(result.gone, false);
  assert.equal(result.piIdentity, null);
  assert.equal(result.sessionFile, null);
  assert.match(note(result), /no Pi process identity was recorded/);
  assert.deepEqual((await readdir(root)).sort(), before);
});

test("assignment observation: missing Pi identity recovers only through an exact terminal pane process", () => {
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const paneIdentity = { pid: 5150, started_at: FLAT_START };
  const record = baseRecord({ pane_id: "%7", launcher_identity: launcherIdentity });
  const terminal = {
    status: "present",
    assignment_id: record.assignment_id,
    pane_id: "%7",
    pid: 5150,
  };

  const recovered = classify(record, observations({
    launcher: { status: "dead" },
    terminal,
    pi: { status: "alive", identity: paneIdentity },
  }));
  assert.equal(recovered.state, "live");
  assert.equal(recovered.gone, false);
  assert.deepEqual(recovered.piIdentity, paneIdentity);

  // A mismatched full UUID never promotes even with a live pane process.
  const wrongTag = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { ...terminal, assignment_id: randomUUID() },
    pi: { status: "alive", identity: paneIdentity },
  }));
  assert.equal(wrongTag.state, "launch_unknown");
  assert.equal(wrongTag.piIdentity, null);

  // A live process with a PID other than the observed pane PID never promotes.
  const wrongPid = classify(record, observations({
    launcher: { status: "dead" },
    terminal,
    pi: { status: "alive", identity: { pid: 5151, started_at: FLAT_START } },
  }));
  assert.equal(wrongPid.state, "launch_unknown");
  assert.equal(wrongPid.piIdentity, null);

  // A mismatched or malformed saved pane never promotes.
  const wrongPane = classify({ ...record, pane_id: "%8" }, observations({
    launcher: { status: "dead" },
    terminal,
    pi: { status: "alive", identity: paneIdentity },
  }));
  assert.equal(wrongPane.state, "launch_unknown");
  assert.equal(wrongPane.piIdentity, null);
  const malformedPane = classify({ ...record, pane_id: "not-a-pane" }, observations({
    launcher: { status: "dead" },
    terminal,
    pi: { status: "alive", identity: paneIdentity },
  }));
  assert.equal(malformedPane.state, "launch_unknown");
  assert.equal(malformedPane.piIdentity, null);

  // Unknown or dead pane process observations never promote.
  for (const pi of [{ status: "unknown" }, { status: "dead" }]) {
    const result = classify(record, observations({ launcher: { status: "dead" }, terminal, pi }));
    assert.equal(result.state, "launch_unknown");
    assert.equal(result.piIdentity, null);
  }

  // A saved Pi identity still requires its exact recorded pid/start: a reused
  // start is never replaced by the recovered pane process.
  const savedReused = classify({
    ...record,
    pi_identity: { pid: 5150, started_at: "Thu Jan  2 00:00:00 1970" },
  }, observations({
    launcher: { status: "dead" },
    terminal,
    pi: { status: "alive", identity: paneIdentity },
  }));
  assert.equal(savedReused.state, "launch_unknown");
  assert.equal(savedReused.piIdentity, null);

  // A malformed saved identity is unknown, not missing: it can neither
  // promote nor authorize gone through complete UUID absence. A missing
  // identity with an incomplete listing likewise never proves gone.
  const malformedSaved = classify({
    ...record,
    pi_identity: { pid: 0, started_at: "" },
  }, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "unknown" },
    uuidProcesses: { status: "absent" },
  }));
  assert.equal(malformedSaved.state, "launch_unknown");
  assert.equal(malformedSaved.gone, false);
  assert.equal(malformedSaved.piIdentity, null);
  assert.match(note(malformedSaved), /malformed/);

  const defaultAbsent = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "unknown" },
    uuidProcesses: { status: "unknown" },
  }));
  assert.equal(defaultAbsent.state, "launch_unknown");
  assert.equal(defaultAbsent.gone, false);

  // A live missing-identity process observation blocks gone even when the
  // listing is complete and shows no UUID.
  const aliveMissing = classify(record, observations({
    launcher: { status: "dead" },
    terminal: { status: "absent" },
    pi: { status: "alive", identity: paneIdentity },
    uuidProcesses: { status: "absent" },
  }));
  assert.equal(aliveMissing.state, "launch_unknown");
  assert.equal(aliveMissing.gone, false);
});

test("assignment observation: missing Pi identity composition promotes through the observed pane process", async () => {
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const record = baseRecord({ pane_id: "%7", launcher_identity: launcherIdentity });
  const tmuxRun = tmuxRunFor({
    tag: record.assignment_id,
    pane: { paneId: "%7", panePid: 5150 },
  });
  const inspect = (pid) => (pid === 5150
    ? { state: "alive", pid, started_at: FLAT_START }
    : { state: "dead", pid });

  const live = await observeAssignment(record, {
    inspect,
    tmuxRun,
    psRun: async () => ({ stdout: "", complete: false }),
  });
  assert.equal(live.state, "live");
  assert.equal(live.gone, false);
  assert.deepEqual(live.piIdentity, { pid: 5150, started_at: FLAT_START });

  // A malformed alive observation (empty start) is unknown, never a reused
  // process absence, so a dead launcher still cannot prove gone.
  const malformed = await observeAssignment(record, {
    inspect: (pid) => ({ state: "alive", pid, started_at: "" }),
    tmuxRun,
    psRun: async () => ({ stdout: "", complete: false }),
  });
  assert.equal(malformed.state, "launch_unknown");
  assert.equal(malformed.gone, false);
  assert.equal(malformed.piIdentity, null);

  // A dead launcher with a reachable-but-absent terminal and the default
  // incomplete listing still never sets gone without a saved Pi identity.
  const absent = await observeAssignment(record, compositionProbes());
  assert.equal(absent.state, "launch_unknown");
  assert.equal(absent.gone, false);
});

test("assignment observation: saved identity malformed observations and probe failures never prove gone", async () => {
  const launcherIdentity = { pid: 4241, started_at: FLAT_START };
  const savedPi = { pid: 4242, started_at: FLAT_START };
  const record = baseRecord({ pi_identity: savedPi, launcher_identity: launcherIdentity });
  const completeAbsence = async () => ({ stdout: "4242 /usr/bin/node\n", complete: true });

  // A dead launcher with an alive Pi whose start text is empty is unknown
  // evidence, never a reused-process absence, even with complete UUID absence.
  const malformedSaved = await observeAssignment(record, compositionProbes({
    inspect: (pid) => (pid === 4241
      ? { state: "dead", pid }
      : { state: "alive", pid, started_at: "" }),
    psRun: completeAbsence,
  }));
  assert.equal(malformedSaved.state, "launch_unknown");
  assert.equal(malformedSaved.gone, false);
  assert.equal(malformedSaved.piIdentity, null);

  // An inspector failure is unknown for both identities and never gone.
  const eperm = await observeAssignment(record, compositionProbes({
    inspect: () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); },
    psRun: completeAbsence,
  }));
  assert.equal(eperm.state, "launch_unknown");
  assert.equal(eperm.gone, false);
  assert.equal(eperm.piIdentity, null);

  // An unknown launcher with a dead Pi never proves gone either.
  const unknownLauncher = await observeAssignment(record, compositionProbes({
    inspect: (pid) => (pid === 4241
      ? { state: "unknown", pid, reason: "ETIMEDOUT" }
      : { state: "dead", pid }),
    psRun: completeAbsence,
  }));
  assert.equal(unknownLauncher.state, "launch_unknown");
  assert.equal(unknownLauncher.gone, false);
});

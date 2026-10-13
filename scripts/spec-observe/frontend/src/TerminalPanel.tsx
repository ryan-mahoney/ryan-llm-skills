// Reusable live-terminal section. The pure terminal-state owner decides every
// label/tone/message/retry/player value; this component contributes the
// value-stable assignment identity, the generation-guarded authorized open
// and the shared, recoverable player assets. Step 7 owns production mounts.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { HttpError, postJson } from './api';
import { StatusText } from './primitives';
import { terminalPanelState, type TerminalConnection } from './terminal-state';

export type TerminalPanelAssignment = { assignment_id?: string; display?: string | null };

type TerminalPlayerInstance = {
  dispose?: () => void;
  addEventListener?: (event: string, listener: () => void) => void;
  removeEventListener?: (event: string, listener: () => void) => void;
};

declare global {
  interface Window {
    AsciinemaPlayer?: {
      create(
        source: { driver: string; url: string },
        element: HTMLElement,
        options: { controls: boolean; autoPlay: boolean; fit: string },
      ): TerminalPlayerInstance;
    };
  }
}

const OPENABLE_DISPLAYS = new Set(['live', 'live-unrecorded']);
const CONNECTING_EXPLANATION_MS = 300;
const CONNECTION_DEADLINE_MS = 5000;
const ASSET_DEADLINE_MS = 5000;
// The authorized-open POST/body phase emits no player events, so the
// connection deadline cannot bound it; it gets its own finite bound. It
// stays above the fixture's held-Connecting delay (8 s) so the step-7
// captures keep observing Connecting, and below postJson's 30 s default
// so a stalled open surfaces the network failure with Retry promptly.
const OPEN_DEADLINE_MS = 10000;

type AssetEntry = { promise: Promise<void>; owned: (HTMLLinkElement | HTMLScriptElement)[] };
// Successful asset loads are shared by every panel watching the same
// assignment; a failed or timed-out load resets the entry so Retry can
// reload, removing only the nodes that load owned.
const assetLoads = new Map<string, AssetEntry>();

function loadTerminalAssets(assignmentId: string): Promise<void> {
  const shared = assetLoads.get(assignmentId);
  if (shared) return shared.promise;
  const owned: (HTMLLinkElement | HTMLScriptElement)[] = [];
  const entry: AssetEntry = { promise: Promise.resolve(), owned };
  const load = async () => {
    const base = `/api/assignment-terminal/${encodeURIComponent(assignmentId)}`;
    const styles = document.createElement('link');
    styles.rel = 'stylesheet';
    styles.href = `${base}/asciinema-player.css`;
    const script = document.createElement('script');
    script.src = `${base}/asciinema-player.min.js`;
    owned.push(styles, script);
    const stylesReady = new Promise<void>((resolve, reject) => {
      styles.addEventListener('load', () => resolve());
      styles.addEventListener('error', () => reject(new Error('Player styles did not load.')));
    });
    const scriptReady = new Promise<void>((resolve, reject) => {
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => reject(new Error('Player script did not load.')));
    });
    document.head.append(styles, script);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([stylesReady, scriptReady]),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Player assets timed out.')), ASSET_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      while (owned.length > 0) owned.pop()?.remove();
      if (assetLoads.get(assignmentId) === entry) assetLoads.delete(assignmentId);
      throw error;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  };
  entry.promise = load();
  assetLoads.set(assignmentId, entry);
  return entry.promise;
}

const websocketUrl = (assignmentId: string) => {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/assignment-terminal/${encodeURIComponent(assignmentId)}/ws`;
};

export function TerminalPanel(props: { assignment: TerminalPanelAssignment | null; live: boolean; localOnly: boolean; token?: string }) {
  const [connection, setConnection] = createSignal<TerminalConnection>('idle');
  const [connectingDelayed, setConnectingDelayed] = createSignal(false);
  const [openBusy, setOpenBusy] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);
  const [retryNonce, setRetryNonce] = createSignal(0);
  let frame!: HTMLDivElement;
  let generation = 0;

  const assignmentId = () => (props.assignment?.assignment_id ? props.assignment.assignment_id : undefined);
  const hasToken = () => typeof props.token === 'string' && props.token.length > 0;
  const openableDisplay = () => {
    const display = props.assignment?.display;
    return display == null || OPENABLE_DISPLAYS.has(display);
  };
  const eligible = () => props.live && !props.localOnly && hasToken() && assignmentId() !== undefined && openableDisplay();
  // Value-stable identity: assignment, eligibility inputs and the retry
  // nonce as one string so a fresh row object never reopens the panel.
  const identityKey = createMemo(() => JSON.stringify([
    assignmentId() ?? null,
    props.assignment?.display ?? null,
    props.live,
    props.localOnly,
    props.token ?? null,
    retryNonce(),
  ]));
  const panelState = createMemo(() => terminalPanelState({
    live: props.live,
    localOnly: props.localOnly,
    hasToken: hasToken(),
    display: assignmentId() === undefined ? 'unknown' : (props.assignment?.display ?? null),
    connection: connection(),
    connectingDelayed: connectingDelayed(),
  }));

  const retry = () => {
    if (openBusy() || retrying()) return;
    setRetrying(true);
    setRetryNonce(nonce => nonce + 1);
  };

  createEffect(on(identityKey, () => {
    const current = ++generation;
    const controller = new AbortController();
    let activePlayer: TerminalPlayerInstance | undefined;
    let connectingTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionDeadline: ReturnType<typeof setTimeout> | undefined;
    let playerSettled = false;

    const stale = () => generation !== current || controller.signal.aborted;
    const clearConnectingTimer = () => {
      if (connectingTimer !== undefined) {
        clearTimeout(connectingTimer);
        connectingTimer = undefined;
      }
    };
    const clearConnectionDeadline = () => {
      if (connectionDeadline !== undefined) {
        clearTimeout(connectionDeadline);
        connectionDeadline = undefined;
      }
    };
    const settle = () => {
      setOpenBusy(false);
      setRetrying(false);
    };

    function failConnection() {
      if (stale()) return;
      playerSettled = true;
      clearConnectionDeadline();
      clearConnectingTimer();
      settle();
      setConnection('network');
      disposePlayer();
    }

    function onLoading() {
      if (stale() || playerSettled) return;
      setConnection('connecting');
      clearConnectionDeadline();
      connectionDeadline = setTimeout(failConnection, CONNECTION_DEADLINE_MS);
    }

    function onPlaying() {
      if (stale() || playerSettled) return;
      playerSettled = true;
      clearConnectionDeadline();
      clearConnectingTimer();
      settle();
      setConnection('open');
    }

    function disposePlayer() {
      const instance = activePlayer;
      if (!instance) return;
      activePlayer = undefined;
      instance.removeEventListener?.('loading', onLoading);
      instance.removeEventListener?.('playing', onPlaying);
      instance.removeEventListener?.('offline', failConnection);
      instance.removeEventListener?.('errored', failConnection);
      instance.dispose?.();
    }

    setConnection('idle');
    setConnectingDelayed(false);
    setOpenBusy(false);

    onCleanup(() => {
      controller.abort();
      clearConnectingTimer();
      clearConnectionDeadline();
      disposePlayer();
      if (generation === current) generation += 1;
    });

    if (!eligible()) {
      setRetrying(false);
      return;
    }

    const id = assignmentId()!;
    const token = props.token ?? '';
    setOpenBusy(true);
    setConnection('connecting');
    connectingTimer = setTimeout(() => {
      if (!stale()) setConnectingDelayed(true);
    }, CONNECTING_EXPLANATION_MS);

    const open = async () => {
      try {
        // Compose lifecycle cancellation with a finite open deadline:
        // passing controller.signal alone would replace postJson's default
        // AbortSignal.timeout(30000) and leave a stalled POST or response
        // body pending forever. A deadline abort rejects here as a
        // non-HttpError, so it settles to the network failure with Retry,
        // while a lifecycle abort stays stale-guarded above; either way the
        // late response is refused and cannot complete the open.
        await postJson<{ assignment_id?: string }>('/api/assignment-terminal/open', { assignment_id: id }, token, AbortSignal.any([controller.signal, AbortSignal.timeout(OPEN_DEADLINE_MS)]));
      } catch (error) {
        if (stale()) return;
        settle();
        if (error instanceof HttpError) setConnection(error.terminalState ?? 'failed');
        else setConnection('network');
        return;
      }
      if (stale()) return;
      try {
        await loadTerminalAssets(id);
      } catch {
        if (stale()) return;
        settle();
        setConnection('failed');
        return;
      }
      if (stale()) return;
      const installed = window.AsciinemaPlayer;
      if (!installed || typeof installed.create !== 'function') {
        settle();
        setConnection('failed');
        return;
      }
      let created: TerminalPlayerInstance;
      try {
        created = installed.create({ driver: 'websocket', url: websocketUrl(id) }, frame, { controls: false, autoPlay: true, fit: 'width' });
      } catch {
        settle();
        setConnection('failed');
        return;
      }
      if (stale()) {
        try {
          created.dispose?.();
        } catch {
          // A late create is discarded, never mounted.
        }
        return;
      }
      activePlayer = created;
      created.addEventListener?.('loading', onLoading);
      created.addEventListener?.('playing', onPlaying);
      created.addEventListener?.('offline', failConnection);
      created.addEventListener?.('errored', failConnection);
      connectionDeadline = setTimeout(failConnection, CONNECTION_DEADLINE_MS);
    };
    void open();
  }));

  return <section class="section terminal-view" aria-labelledby="live-terminal-heading">
    <div class="section-head">
      <h3 id="live-terminal-heading">Live terminal</h3>
      <StatusText tone={panelState().tone}>{panelState().label}</StatusText>
    </div>
    <p class="small" role="status">{panelState().message}</p>
    <Show when={panelState().retry || retrying()}>
      <button type="button" class="ds-btn" disabled={openBusy() || retrying()} onClick={retry}>Retry</button>
    </Show>
    <div class="terminal-frame" ref={frame} hidden={!panelState().player} />
  </section>;
}

export default TerminalPanel;

import { For, Show, createEffect, createSignal, createUniqueId, type JSX } from 'solid-js';
import { formatHash, type Destination, type RouteState } from './route';
import { StatusText, type StatusTone } from './primitives';

export type ShellNavEntry = { dest: Destination; label: string; count?: number };
export type ShellWorkspaceOption = { id: string; label: string };

export type ShellProps = {
  route: RouteState;
  currentDestination?: Destination;
  primaryNav: readonly ShellNavEntry[];
  directoryNav?: readonly ShellNavEntry[];
  workspaceOptions: readonly ShellWorkspaceOption[];
  scope?: string;
  onScopeChange(next: string | undefined): void;
  onDestination(dest: Destination): void;
  home?: Destination;
  crumbs: readonly string[];
  title: string;
  headerActions?: JSX.Element;
  connection: { label: string; tone?: StatusTone };
  observedAt?: string;
  onRefresh(): void;
  onImport(file: File | undefined): void;
  onRequestWork(): void;
  children: JSX.Element;
};

const navIcons: Partial<Record<Destination, () => JSX.Element>> = {
  'next-steps': () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 5h11M4 12h8M4 19h11"/><path d="M15 9l4 3-4 3"/></svg>
  ),
  specs: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
  epics: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="8" y="14" width="7" height="7" rx="1" />
      <path d="M6 10v3h5M18 10v3h-6" />
    </svg>
  ),
  agents: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="4" y="7" width="16" height="13" rx="3" />
      <path d="M12 3v4M8 12h.01M16 12h.01M8 16h8" />
    </svg>
  ),
  conversations: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M4 4h16v12H9l-5 4V4z" />
    </svg>
  ),
  files: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M3 6h7l2 3h9v11H3zM3 6V4h7l2 2" />
    </svg>
  ),
  designs: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M9 10h12" />
    </svg>
  ),
  workspaces: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M8 7V3h8v4M3 12h18" />
    </svg>
  ),
  models: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  ),
};

// The hidden launch flow has no rail entry, so the icon map stays partial.
const navIcon = (dest: Destination) => navIcons[dest] ?? navIcons.specs!;

export default function Shell(props: ShellProps) {
  const scopeId = createUniqueId();
  const headingId = createUniqueId();
  let main: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  let importInput: HTMLInputElement | undefined;

  const [importFeedback, setImportFeedback] = createSignal('');

  const home = () => props.home ?? 'specs';
  const destinationHref = (dest: Destination) => formatHash(props.scope ? { dest, ws: props.scope } : { dest });
  const focusHeading = () => (heading ?? main)?.focus({ preventScroll: true });

  let lastDestination: Destination | undefined;
  createEffect(() => {
    const destination = props.route.dest;
    if (lastDestination !== undefined && lastDestination !== destination) focusHeading();
    lastDestination = destination;
  });

  const go = (dest: Destination) => (event: MouseEvent) => {
    event.preventDefault();
    props.onDestination(dest);
  };

  const navLink = (entry: ShellNavEntry) => {
    // A hidden child flow highlights its parent destination in the rail.
    const current = () => (props.currentDestination ?? props.route.dest) === entry.dest;
    return (
      <a
        class={current() ? 'nav-item current' : 'nav-item'}
        data-area={entry.dest}
        href={destinationHref(entry.dest)}
        aria-current={current() ? 'page' : undefined}
        onClick={go(entry.dest)}
      >
        {navIcon(entry.dest)()}
        <span>{entry.label}</span>
        {entry.count !== undefined && entry.count > 0 ? <span class="nav-count" aria-label={`${entry.count} waiting`}>{entry.count}</span> : null}
      </a>
    );
  };

  const onScopeInput = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    props.onScopeChange(value || undefined);
  };

  const onImportInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    setImportFeedback(file ? `Selected snapshot: ${file.name}` : '');
    input.value = '';
    props.onImport(file);
  };

  const scopeMissing = () => props.scope !== undefined && props.scope !== '' && !props.workspaceOptions.some(option => option.id === props.scope);

  return (
    <>
      <button class="skip" type="button" onClick={focusHeading}>
        Skip to content
      </button>
      <div class="app">
        <aside class="rail" aria-label="Application navigation">
          <a class="brand" href={destinationHref(home())} onClick={event => { event.preventDefault(); props.onDestination(home()); }}>
            {navIcon(home())()}
            <span>Sentinel</span>
          </a>
          <div class="scope">
            <label for={scopeId}>Workspace</label>
            <select id={scopeId} aria-label="Workspace scope" value={props.scope ?? ''} onChange={onScopeInput}>
              <option value="" selected={!props.scope}>All workspaces</option>
              <For each={props.workspaceOptions}>{option => <option value={option.id} selected={String(option.id) === (props.scope ?? '')}>{option.label}</option>}</For>
              <Show when={scopeMissing()}>
                <option value={props.scope ?? ''} selected>{props.scope}</option>
              </Show>
            </select>
          </div>
          <nav aria-label="Primary">
            <For each={props.primaryNav}>{navLink}</For>
          </nav>
          <Show when={props.directoryNav?.length}>
            <div class="rail-rule" />
            <nav aria-label="Workspace directory">
              <For each={props.directoryNav ?? []}>{navLink}</For>
            </nav>
          </Show>
          <div class="rail-footer">
            <StatusText id="connection-status" tone={props.connection.tone}>
              {props.connection.label}
            </StatusText>
            <Show when={props.observedAt}>
              <p style={{ 'margin-top': '8px' }}>Observed at {props.observedAt}</p>
            </Show>
            <a
              id="refresh-button"
              href={formatHash(props.route)}
              onClick={event => {
                event.preventDefault();
                props.onRefresh();
              }}
            >
              Refresh state
            </a>
            <button
              id="import-button"
              class="text-link"
              type="button"
              style={{ background: 'none', border: '0', padding: '0', color: 'var(--ds-muted)' }}
              onClick={() => importInput?.click()}
            >
              Import snapshot
            </button>
            <input
              id="import-file"
              ref={el => (importInput = el)}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={onImportInput}
            />
            <p role="status" aria-live="polite">
              {importFeedback()}
            </p>
          </div>
        </aside>
        <main id="main" class="main" tabindex="-1" ref={el => (main = el)}>
          <header class="page-head">
            <div>
              <div class="crumb">
                <For each={props.crumbs}>
                  {(part, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span aria-hidden="true">/</span>
                      </Show>
                      <span>{part}</span>
                    </>
                  )}
                </For>
              </div>
              <h1 id={headingId} tabindex="-1" ref={el => (heading = el)}>
                {props.title}
              </h1>
            </div>
            <button id="request-work-trigger" type="button" class="ds-btn" onClick={() => props.onRequestWork()}>Request work</button>
            <Show when={props.headerActions}>
              <div class="head-actions">{props.headerActions}</div>
            </Show>
          </header>
          {props.children}
        </main>
      </div>
    </>
  );
}

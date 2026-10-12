import { For, Show, type JSX } from 'solid-js';

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export function StatusText(props: { id?: string; tone?: StatusTone; dot?: boolean; children: JSX.Element }) {
  return (
    <span id={props.id} class={`status ${props.tone ?? 'neutral'}`}>
      <Show when={props.dot !== false}>
        <span class="status-dot" aria-hidden="true" />
      </Show>
      {props.children}
    </span>
  );
}

export function MasterDetail(props: { listLabel: string; list: JSX.Element; children: JSX.Element }) {
  return (
    <div class="workspace">
      <aside class="list-pane" aria-label={props.listLabel}>
        {props.list}
      </aside>
      <article class="detail-pane">{props.children}</article>
    </div>
  );
}

export function StateNotice(props: { tone?: StatusTone; title?: string; action?: JSX.Element; announce?: boolean; children: JSX.Element }) {
  return (
    <div class={`ds-callout ${props.tone ?? 'neutral'}`} role={props.announce === false ? undefined : 'status'}>
      <div>
        <Show when={props.title}>
          <strong>{props.title}</strong>
        </Show>
        <p>{props.children}</p>
      </div>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}

export function RegionalSkeleton(props: { rows?: number; label?: string; announce?: boolean; variant?: 'table' }) {
  const rows = () => props.rows ?? 3;
  const announcing = () => props.announce !== false;
  return (
    <div class={props.variant === 'table' ? 'skeletons skeletons-table' : 'skeletons'} role={announcing() ? 'status' : undefined} aria-label={announcing() ? (props.label ?? 'Loading') : undefined} aria-busy="true" aria-hidden={announcing() ? undefined : 'true'}>
      <For each={Array.from({ length: rows() })}>
        {() =>
          props.variant === 'table' ? (
            <div class="skeleton-row" aria-hidden="true">
              <div class="skeleton-cell"><span class="skeleton-bar" /><span class="skeleton-bar skeleton-bar--secondary" /></div>
              <div class="skeleton-cell"><span class="skeleton-bar" /><span class="skeleton-bar skeleton-bar--secondary" /></div>
              <div class="skeleton-cell"><span class="skeleton-bar" /><span class="skeleton-bar skeleton-bar--secondary" /></div>
            </div>
          ) : (
            <div class="skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )
        }
      </For>
    </div>
  );
}

export function EmptyState(props: { symbol?: string; title: string; text?: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="empty">
      <Show when={props.symbol}>
        <span class="empty-symbol" aria-hidden="true">
          {props.symbol}
        </span>
      </Show>
      <h2>{props.title}</h2>
      <Show when={props.text}>
        <p>{props.text}</p>
      </Show>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}

export type SectionTab = { key: string; label: string; href?: string };

export function SectionTabs(props: {
  label: string;
  tabs: readonly SectionTab[];
  active: string;
  variant?: 'sections' | 'filters';
  onSelect(key: string): void;
}) {
  return (
    <nav class={props.variant === 'filters' ? 'filter-strip' : 'tabs'} aria-label={props.label}>
      <For each={props.tabs}>
        {tab => {
          const current = () => tab.key === props.active;
          const className = () => (current() ? 'active' : '');
          const select = (event: MouseEvent) => {
            event.preventDefault();
            props.onSelect(tab.key);
          };
          return tab.href ? (
            <a class={className()} href={tab.href} aria-current={current() ? 'page' : undefined} onClick={select}>
              {tab.label}
            </a>
          ) : (
            <button type="button" class={className()} aria-pressed={current()} onClick={select}>
              {tab.label}
            </button>
          );
        }}
      </For>
    </nav>
  );
}

export function ActionBar(props: { variant?: 'bar' | 'inline'; children: JSX.Element }) {
  return <div class={props.variant === 'inline' ? 'actions' : 'detail-actions'}>{props.children}</div>;
}

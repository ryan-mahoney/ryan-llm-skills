import { Show, createEffect, type JSX } from 'solid-js';

export type RequestWorkScopeLine = { label: string; kind: string };

export type RequestWorkPanelProps = {
  open: boolean;
  onClose(): void;
  scope?: RequestWorkScopeLine;
  onRemoveScope?: () => void;
  children?: JSX.Element;
};

// Step-9 shell of the screen-1 "Request work" command panel: header, removable
// context chip, empty body slot and disabled footer actions. The native dialog
// supplies the modal and focus trap; Escape is routed through onCancel so
// closing this panel can never cancel launched work (INV-1). The export is
// named RequestWorkPanel because request-state.ts already exports a
// RequestWork type.
export default function RequestWorkPanel(props: RequestWorkPanelProps) {
  let dialog!: HTMLDialogElement;
  let heading!: HTMLHeadingElement;

  createEffect(() => {
    if (props.open) {
      dialog.showModal();
      heading.focus({ preventScroll: true });
    } else {
      dialog.close();
    }
  });

  return (
    <dialog
      id="request-work-dialog"
      class="request-work"
      aria-labelledby="request-work-title"
      ref={dialog}
      onCancel={event => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class="cmd-head">
        <h2 id="request-work-title" tabindex="-1" ref={heading}>Request work</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close request panel"
          title="Close (Esc)"
          onClick={() => props.onClose()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <Show when={props.scope}>
        {scope => (
          <div class="cmd-context">
            <span class="ctx-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>
              <span>Context: <strong>{scope().label}</strong> · {scope().kind}</span>
            </span>
            <Show when={props.onRemoveScope}>
              <button
                type="button"
                class="ctx-remove"
                aria-label="Remove context"
                title="Remove context"
                onClick={() => props.onRemoveScope?.()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </Show>
          </div>
        )}
      </Show>
      <div class="cmd-body">{props.children}</div>
      <div class="cmd-foot">
        <p class="foot-note">Actions become available once a request is interpreted.</p>
        <button type="button" class="ds-btn" disabled>Start conversation</button>
        <button type="button" class="ds-btn ds-btn--primary" disabled>Plan epic</button>
      </div>
      <p class="sr-only" role="status" aria-live="polite"></p>
    </dialog>
  );
}

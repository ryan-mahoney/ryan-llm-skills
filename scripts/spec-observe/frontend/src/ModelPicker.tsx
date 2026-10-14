import { createEffect, createSignal, For, Show } from 'solid-js';
import type { ModelChoice } from './models-state';
import { pickerOptions, catalog, loadPreferences, loadCatalog, preferred } from './models-state';

type Props = {
  id: string;
  value: ModelChoice | null;
  onChange: (choice: ModelChoice | null) => void;
  live: boolean;
  disabled?: boolean;
  onManage?: () => void;
};

export default function ModelPicker(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [activeId, setActiveId] = createSignal('');
  const [typeaheadBuffer, setTypeaheadBuffer] = createSignal('');

  const opts = () => pickerOptions({
    preferred: preferred(),
    catalog: catalog(),
    selected: props.value
  });

  const selected = () => props.value;

  const selectedOption = () => {
    const o = opts();
    return o.find(opt => {
      if (selected() === null) return opt.choice === null;
      if (opt.choice === null) return false;
      return opt.choice.provider === selected()!.provider && opt.choice.model === selected()!.model;
    });
  };

  const enabledOptions = () => opts().filter(o => !o.disabled);
  const enabledCount = () => enabledOptions().length;



  const getActiveIndex = () => {
    const all = opts();
    const idx = all.findIndex((opt, i) => `${props.id}-opt-${i}` === activeId());
    return idx >= 0 ? idx : 0;
  };

  const openList = () => {
    if (props.disabled) return;
    if (props.live) void loadCatalog();
    setOpen(true);
    const enabled = enabledOptions();
    if (enabled.length > 0) {
      const sel = selectedOption();
      const all = opts();
      if (sel && !sel.disabled) {
        const idx = all.indexOf(sel);
        setActiveId(`${props.id}-opt-${idx}`);
      } else {
        setActiveId(`${props.id}-opt-${all.indexOf(enabled[0])}`);
      }
    }
  };

  const closeList = () => setOpen(false);

  const moveToEnabled = (dir: -1 | 1) => {
    const all = opts();
    if (all.length === 0) return;
    let idx = getActiveIndex();
    for (let i = 0; i < all.length; i++) {
      idx = (idx + dir + all.length) % all.length;
      if (!all[idx].disabled) {
        setActiveId(`${props.id}-opt-${idx}`);
        break;
      }
    }
  };

  const commitActive = () => {
    const all = opts();
    const idx = getActiveIndex();
    const option = all[idx];
    if (option && !option.disabled) {
      props.onChange(option.choice);
      closeList();
    }
  };

  const handleTriggerKey = (e: KeyboardEvent) => {
    if (!open()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveToEnabled(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveToEnabled(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const all = opts();
      for (let i = 0; i < all.length; i++) {
        if (!all[i].disabled) {
          setActiveId(`${props.id}-opt-${i}`);
          break;
        }
      }
    } else if (e.key === 'End') {
      e.preventDefault();
      const all = opts();
      for (let i = all.length - 1; i >= 0; i--) {
        if (!all[i].disabled) {
          setActiveId(`${props.id}-opt-${i}`);
          break;
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitActive();
    } else if (e.key === ' ') {
      e.preventDefault();
      commitActive();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList();
      const trigger = document.getElementById(props.id);
      trigger?.focus();
    } else if (e.key === 'Tab') {
      closeList();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const buf = typeaheadBuffer() + e.key.toLowerCase();
      setTypeaheadBuffer(buf);
      const all = opts();
      let startedFrom = getActiveIndex();
      let wrapped = false;
      for (let i = 1; i <= all.length; i++) {
        let idx = (startedFrom + i) % all.length;
        if (!all[idx].disabled) {
          const label = all[idx].choice ? `${all[idx].choice!.model.toLowerCase()} ${all[idx].choice!.provider.toLowerCase()}` : 'pi default';
          if (label.startsWith(buf)) {
            setActiveId(`${props.id}-opt-${idx}`);
            break;
          }
        }
        if (i === all.length) {
          for (let j = 0; j < startedFrom; j++) {
            if (!all[j].disabled) {
              const label = all[j].choice ? `${all[j].choice!.model.toLowerCase()} ${all[j].choice!.provider.toLowerCase()}` : 'pi default';
              if (label.startsWith(buf)) {
                setActiveId(`${props.id}-opt-${j}`);
                wrapped = true;
                break;
              }
            }
          }
          if (wrapped) break;
        }
      }
      setTimeout(() => setTypeaheadBuffer(''), 600);
    }
  };

  createEffect(() => {
    if (props.live) {
      void loadPreferences();
      void loadCatalog();
    }
  });

  const catalogView = () => catalog();

  const selectedAvailability = () => {
    if (!props.value) return 'available';
    const view = catalogView();
    if (view.status !== 'ready') return 'unknown';
    const key = JSON.stringify([props.value.provider, props.value.model]);
    const found = view.models.some(m => JSON.stringify([m.provider, m.model]) === key);
    return found ? 'available' : 'missing';
  };

  const showFieldError = () => {
    if (!props.value || selectedAvailability() === 'available') return false;
    return true;
  };

  const errorHost = () => catalogView().host ?? 'catalog';

  return (
    <div class="field mfield">
      <label id={props.id + '-label'} for={props.id}>Model</label>
      <button
        type="button"
        id={props.id}
        role="combobox"
        class="mtrigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={props.id + '-list'}
        aria-activedescendant={open() ? activeId() : undefined}
        aria-labelledby={props.id + '-label'}
        aria-describedby={props.id + '-help'}
        disabled={props.disabled}
        onClick={() => { if (!props.disabled && open()) closeList(); else if (!props.disabled) openList(); }}
        onKeyDown={handleTriggerKey}
      >
        <span class="mval">
          <Show when={selected() === null} fallback={
            <>
              <span class="mid">{selected()!.model}</span>
              <span class="mprov">{selected()!.provider}</span>
            </>
          }>
            <span class="mid default">Pi default</span>
          </Show>
        </span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      <small id={props.id + '-help'}>Preferred models, A–Z. Pi default uses the host configuration.</small>

      <Show when={open()}>
        <div class="mlist" id={props.id + '-list'}>
          <ul role="listbox" aria-labelledby={props.id + '-label'}>
            <For each={opts()}>
              {(opt, i) => (
                <li
                  role="option"
                  id={props.id + '-opt-' + i()}
                  aria-selected={opt.selected}
                  aria-disabled={opt.disabled}
                  class={opt.disabled ? 'mopt' : 'mopt ' + ((props.id + '-opt-' + i()) === activeId() ? 'active' : '') + (opt.choice === null ? ' default' : '')}
                  onClick={() => {
                    if (!opt.disabled) {
                      props.onChange(opt.choice);
                      closeList();
                    }
                  }}
                >
                  <span class="check" aria-hidden="true">
                    <Show when={opt.selected}>✓</Show>
                  </span>
                  <Show when={opt.choice === null} fallback={<span class="mid">{opt.choice!.model}</span>}>
                    <span class="mid default">Pi default</span>
                  </Show>
                  <span class="mprov">
                    <Show when={opt.choice} fallback="Host configuration">{opt.choice!.provider}</Show>
                  </span>
                  <Show when={opt.disabled}>
                    <span class="why">
                      <Show when={opt.availability === 'missing'}>
                        Not in {errorHost()} catalog
                      </Show>
                      <Show when={opt.availability === 'unknown' && catalogView().read_at === null}>
                        Availability unknown; catalog not read
                      </Show>
                      <Show when={opt.availability === 'unknown'}>
                        Availability unknown
                      </Show>
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={preferred().length === 0}>
            <p class="mnote">No preferred models yet. Pi default is always available.</p>
          </Show>
          <div class="mfoot">
            <button
              type="button"
              id={props.id + '-manage'}
              class="text-link"
              onClick={() => {
                closeList();
                props.onManage?.();
              }}
            >
              {preferred().length > 0 ? 'Manage preferred models' : 'Choose preferred models'}
            </button>
          </div>
        </div>
      </Show>

      <Show when={showFieldError()}>
        <div class="field-error" role="alert">
          <Show when={selectedAvailability() === 'missing'} fallback={
            <span>Availability of {selected()!.model} is unknown; the catalog has not been read. Choose Pi default or refresh the Models page.</span>
          }>
            <span>{selected()!.model} is not in the {errorHost()} catalog. Choose another model or manage preferred models.</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

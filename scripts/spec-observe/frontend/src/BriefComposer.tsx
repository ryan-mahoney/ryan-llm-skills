import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { getJson } from './api';
import type { BriefReference, TriggerItem } from './composerTypes';

type Query = { kind: 'skill' | 'file'; text: string; start: number; end: number };
type Props = { id: string; value: string; references: BriefReference[]; workspaceId: string; threadId: string; enabled: boolean;
  onChange(value: string): void; onReferencesChange(refs: BriefReference[]): void; onSave(): void };
const tokenPresent = (text: string, token: string) => text.split(token).some((part, i, parts) => i < parts.length - 1 && (part === '' || /\s$/.test(part)) && (parts[i + 1] === '' || /^[\s.,;!?)]/.test(parts[i + 1])));

export default function BriefComposer(props: Props) {
  let editor!: HTMLTextAreaElement;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false, generation = 0;
  const [query, setQuery] = createSignal<Query | null>(null);
  const [items, setItems] = createSignal<TriggerItem[]>([]);
  const [highlighted, setHighlighted] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [dismissed, setDismissed] = createSignal('');
  const listId = `${props.id}-suggestions`;
  const signature = () => `${props.workspaceId}\0${props.threadId}`;
  const close = () => { setQuery(null); controller?.abort(); clearTimeout(timer); generation++; setLoading(false); };
  const inspect = () => {
    if (composing || !props.enabled || document.activeElement !== editor || editor.selectionStart !== editor.selectionEnd) { close(); return; }
    const end = editor.selectionStart, before = editor.value.slice(0, end);
    // Token boundaries keep paths and email addresses ordinary typing.
    const match = before.match(/(?:^|\s)(?:\/([^\s/@]*)|@([^\s@]*))$/);
    if (!match || dismissed() === before) { close(); return; }
    const text = match[1] ?? match[2];
    setQuery({ kind: match[1] !== undefined ? 'skill' : 'file', text, start: end - text.length - 1, end });
  };
  createEffect(() => { const value = props.value; if (editor && editor.value !== value) editor.value = value; });
  createEffect(() => {
    const q = query(), target = signature(), enabled = props.enabled;
    controller?.abort(); clearTimeout(timer);
    const request = ++generation;
    setItems([]); setHighlighted(0); setError(''); setWarnings([]);
    if (!q || !enabled || !props.threadId) { setLoading(false); return; }
    setLoading(true); controller = new AbortController(); const signal = controller.signal;
    timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ workspace_id: props.workspaceId, thread_id: props.threadId, kind: q.kind, query: q.text });
        const result = await getJson<{items: TriggerItem[]; warnings?: string[]; truncated?: boolean}>(`/api/thread/suggestions?${params}`, signal);
        if (request !== generation || target !== signature() || signal.aborted) return;
        setItems(result.items || []); setWarnings([...(result.warnings || []), ...(result.truncated ? ['More files exist. Narrow the path to find your file.'] : [])]);
      } catch (e) { if (request === generation && !signal.aborted) setError(e instanceof Error ? e.message : 'Suggestions could not be loaded.'); }
      finally { if (request === generation) setLoading(false); }
    }, 120);
  });
  createEffect(() => { signature(); close(); setDismissed(''); });
  onCleanup(close);
  function select(item: TriggerItem) {
    const q = query(); if (!q) return;
    const name = item.kind === 'skill' ? item.label : `${item.source}/${item.label}`;
    const token = `${item.kind === 'skill' ? '/' : '@'}${/\s/.test(name) ? JSON.stringify(name) : name}`;
    const value = editor.value.slice(0, q.start) + token + ' ' + editor.value.slice(q.end);
    props.onChange(value);
    props.onReferencesChange([...props.references.filter(ref => ref.id !== item.id && tokenPresent(value, ref.token)), { ...item, token }]);
    editor.value = value; close(); editor.focus();
    editor.setSelectionRange(q.start + token.length + 1, q.start + token.length + 1);
  }
  function remove(ref: BriefReference) {
    props.onChange(props.value.replace(ref.token, '')); props.onReferencesChange(props.references.filter(item => item.id !== ref.id)); editor.focus();
  }
  return <div class="brief-composer">
    <textarea id={props.id} rows="6" placeholder="Write the assignment brief. Type / for skills or @ for files." ref={editor}
      role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={!!query()} aria-controls={query() ? listId : undefined}
      aria-activedescendant={query() && items()[highlighted()] ? `${listId}-${highlighted()}` : undefined}
      onInput={e => { const value = e.currentTarget.value; props.onChange(value); props.onReferencesChange(props.references.filter(ref => tokenPresent(value, ref.token))); setDismissed(''); inspect(); }}
      onClick={inspect} onFocus={inspect} onBlur={close}
      onCompositionStart={() => { composing = true; close(); }} onCompositionEnd={() => { composing = false; inspect(); }}
      onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) inspect(); }}
      onKeyDown={e => {
        if (composing || e.isComposing) return;
        if (query()) {
          if (e.key === 'Escape') { e.preventDefault(); setDismissed(editor.value.slice(0, editor.selectionStart)); close(); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const size = items().length; if (size) setHighlighted((highlighted() + (e.key === 'ArrowDown' ? 1 : size - 1)) % size); return; }
          if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey && items().length)) { e.preventDefault(); const item = items()[highlighted()]; if (item) select(item); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.onSave(); }
      }} />
    <Show when={query()}><div class="brief-suggestions">
      <div class="small muted">{query()?.kind === 'skill' ? 'Host skills' : 'Files for this target'} · ↑↓ select · Enter or Tab insert · Esc close</div>
      <Show when={loading()}><p role="status">Loading suggestions…</p></Show>
      <Show when={error()}><p class="bad" role="alert">{error()} <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setQuery(query() ? {...query()!} : null); }}>Retry</button></p></Show>
      <div id={listId} role="listbox" aria-label={query()?.kind === 'skill' ? 'Skills' : 'Files'}>
        <For each={items()}>{(item, i) => <button type="button" id={`${listId}-${i()}`} role="option" aria-selected={highlighted() === i()} class="brief-suggestion" onMouseDown={e => e.preventDefault()} onClick={() => select(item)}>
          <span>{item.kind === 'skill' ? '/' : '@'}{item.label}</span><span class="small muted">{item.description}</span><span class="small mono">{item.source}</span>
        </button>}</For>
      </div>
      <Show when={!loading() && !error() && !items().length}><p role="status">{query()?.kind === 'skill' ? 'No matching skills on this host.' : 'No matching text files in this target.'}</p></Show>
      <For each={warnings()}>{warning => <p class="small warn">{warning}</p>}</For>
    </div></Show>
    <Show when={props.references.length}><div class="brief-references" aria-label="Selected assignment context">
      <For each={props.references}>{ref => <span class="brief-reference"><span>{ref.token}</span><button type="button" aria-label={`Remove ${ref.label}`} onClick={() => remove(ref)}>×</button></span>}</For>
      <p class="small muted">Selected skills and text files will be included in Pi’s input. Preview shows their captured contents.</p>
    </div></Show>
  </div>;
}

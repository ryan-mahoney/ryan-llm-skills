// Feature-owned presentational reader body. Fetching, route state and
// selection stay in destinations/files.tsx; this module only renders the
// bytes and URLs it is handed, reusing the shared safe renderer and package
// URL owners.
import { Match, Switch } from 'solid-js';
import { esc, statusMarkdown } from './format';
import { packageViewUrl } from './observation-format';
import { fileKindLabel, fileSizeLabel, relativePackagePath, type FileSource, type LoadedFile } from './files-model';
import { EmptyState } from './primitives';

export type FileReaderProps = {
  file: LoadedFile;
  source: FileSource;
  owner: string;
  readUrl: string;
  downloadUrl: string;
  viewUrl: string;
  offline: boolean;
  downloadEnabled: boolean;
  resourceRetryVersion: number;
  onResourceReady: () => void;
  onResourceError: (message: string) => void;
};

// Package Markdown keeps the shared safe renderer. Only relative asset
// targets are rewritten to authorized package-view URLs; the resolver
// refuses anything that is not one of those generated URLs.
function packageMarkdown(text: string, current: string, owner: string): string {
  const images: string[] = [];
  const withImages = text.replace(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g, (match, alt: string, target: string) => {
    const resolved = relativePackagePath(target, current);
    if (!resolved) return match;
    const token = `PACKAGEIMAGE${images.length}TOKEN`;
    images.push(`<img src="${esc(packageViewUrl(owner, resolved))}" alt="${esc(alt)}" style="max-width:100%">`);
    return token;
  });
  const rewritten = withImages.replace(/(?<!!)\[([^\]\n]*)\]\(([^\s)]+)\)/g, (match, label: string, target: string) => {
    const resolved = relativePackagePath(target, current);
    return resolved ? `[${label}](${packageViewUrl(owner, resolved)})` : match;
  });
  const marker = packageViewUrl(owner, '');
  return statusMarkdown(rewritten, candidate => (candidate.startsWith(marker) ? candidate : null))
    .replace(/PACKAGEIMAGE(\d+)TOKEN/g, (match, index: string) => images[Number(index)] ?? match);
}

const jsonText = (value: string | null): string => {
  const raw = value ?? '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

export function FileReader(props: FileReaderProps) {
  const markdownHtml = () => (props.source === 'package'
    ? packageMarkdown(props.file.text ?? '', props.file.path, props.owner)
    : statusMarkdown(props.file.text ?? ''));
  // Browser-owned resource loads keep the same authorized endpoint; the retry
  // nonce forces a new observable load only after a failed image/iframe
  // display retry. No fetch happens here.
  const resourceSrc = (url: string): string => {
    if (!url || props.resourceRetryVersion === 0) return url;
    return `${url}${url.includes('?') ? '&' : '?'}resource_retry=${props.resourceRetryVersion}`;
  };
  return (
    <Switch>
      <Match when={props.file.kind === 'markdown'}>
        <div class="paper">
          <div id="file-content" class="status-markdown" innerHTML={markdownHtml()} />
        </div>
      </Match>
      <Match when={props.file.kind === 'json'}>
        <div class="paper">
          <pre class="file-code">{jsonText(props.file.text)}</pre>
        </div>
      </Match>
      <Match when={props.file.kind === 'html'}>
        <iframe
          class="html-frame"
          title={props.file.path}
          sandbox="allow-scripts"
          src={resourceSrc(props.viewUrl || props.readUrl)}
          onLoad={() => props.onResourceReady()}
          onError={() => props.onResourceError('The isolated HTML document failed to load.')}
        />
        <p class="section-note">
          HTML is isolated. Scripts run without same-origin access; network and forms are unavailable.
          Only document load is observed; sandbox subresources are not verified.
          {props.offline ? ' Uncached frame resources may be unavailable offline.' : ''}
        </p>
      </Match>
      <Match when={props.file.kind === 'image'}>
        <img
          class="image-preview"
          src={resourceSrc(props.readUrl)}
          alt={props.file.path}
          onLoad={() => props.onResourceReady()}
          onError={() => props.onResourceError('The image could not be displayed. The bytes did not decode as an image.')}
        />
      </Match>
      <Match when={props.file.kind === 'download'}>
        <EmptyState
          symbol="◇"
          title="No inline preview"
          text={`${props.file.path} · ${fileKindLabel(props.file.path)} · ${fileSizeLabel(props.file.size) || 'Size unknown'}. Download the file to inspect its contents.`}
          action={props.downloadEnabled
            ? <a class="ds-btn ds-btn--primary" href={props.downloadUrl} download="">Download file</a>
            : <button type="button" class="ds-btn ds-btn--primary" disabled>Download file</button>}
        />
      </Match>
      <Match when={true}>
        <div class="paper">
          <pre class="file-code">{props.file.text ?? ''}</pre>
        </div>
      </Match>
    </Switch>
  );
}

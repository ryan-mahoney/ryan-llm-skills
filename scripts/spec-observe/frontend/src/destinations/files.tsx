import Files from '../Files';
import type { DestinationProps } from './index';

export default function FilesDestination(props: DestinationProps) {
  const source = (): 'workspace' | 'package' => (props.route.source === 'package' ? 'package' : 'workspace');
  const owner = () => (source() === 'package' ? (props.route.id ?? '') : (props.route.ws ?? ''));
  const directoryPath = () => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? path : null;
  };
  const recentCompletion = () => {
    if (source() !== 'package') return undefined;
    return Boolean(props.records.find(item => item.package === owner())?.recent_completion);
  };
  return (
    <div class="full-page">
      <div class="detail">
        <Files
          source={source()}
          owner={owner()}
          live={props.live}
          initialFile={directoryPath() ? null : (props.route.path ?? null)}
          pathPrefix={directoryPath() ?? undefined}
          recentCompletion={recentCompletion()}
        />
      </div>
    </div>
  );
}

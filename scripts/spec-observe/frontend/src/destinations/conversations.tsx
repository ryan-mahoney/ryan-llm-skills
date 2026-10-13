import Threads from '../Threads';
import type { DestinationProps } from './index';

export default function ConversationsDestination(props: DestinationProps) {
  const repositories = () => {
    const data = props.workspace;
    return data && Array.isArray(data.repositories) ? data.repositories : [];
  };
  return (
    <div class="full-page">
      <div class="detail">
        <Threads
          workspaceId={props.route.ws ?? ''}
          repositories={repositories()}
          token={props.token}
          live={props.live}
          refreshKey={props.refreshKey}
          requestedThreadId={props.route.id}
          onNavigate={props.onNavigate}
        />
      </div>
    </div>
  );
}

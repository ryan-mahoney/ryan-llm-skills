import Threads from '../Threads';
import type { DestinationProps } from './index';

export default function ConversationsDestination(props: DestinationProps) {
  // Route identity, the workspace record (for reactive repository options)
  // and the catalog context pass straight through; Threads owns deriving the
  // workspace id and repository list from them.
  return (
    <div class="full-page">
      <div class="detail">
        <Threads
          route={props.route}
          workspace={props.workspace}
          catalog={props.catalog}
          token={props.token}
          live={props.live}
          refreshKey={props.refreshKey}
          onNavigate={props.onNavigate}
        />
      </div>
    </div>
  );
}

import Conversations from '../Conversations';
import type { DestinationProps } from './index';

export default function ConversationsDestination(props: DestinationProps) {
  // Route identity, the workspace record (for reactive repository options)
  // and the catalog context pass straight through; the migrated Conversations
  // owner derives the workspace id, repository list and target metadata from
  // them. The layout-neutral wrapper keeps MasterDetail directly under the
  // shell region it fills.
  return (
    <div class="conversations-destination">
      <Conversations
        route={props.route}
        workspace={props.workspace}
        catalog={props.catalog}
        token={props.token}
        live={props.live}
        refreshKey={props.refreshKey}
        onNavigate={props.onNavigate}
      />
    </div>
  );
}

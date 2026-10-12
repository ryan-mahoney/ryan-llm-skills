import Designs from '../Designs';
import type { DestinationProps } from './index';

export default function DesignsDestination(props: DestinationProps) {
  return (
    <div class="full-page">
      <div class="detail">
        <Designs workspaceId={props.route.ws ?? ''} live={props.live} />
      </div>
    </div>
  );
}

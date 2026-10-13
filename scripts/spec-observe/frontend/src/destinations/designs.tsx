import Designs from '../Designs';
import type { DestinationProps } from './index';

// Designs owns its own master-detail grid and announcements, so the adapter
// passes the destination props through without stacking layout wrappers.
export default function DesignsDestination(props: DestinationProps) {
  return <Designs {...props} />;
}

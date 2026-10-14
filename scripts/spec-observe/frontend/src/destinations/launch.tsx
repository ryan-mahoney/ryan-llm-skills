import Launch from '../Launch';
import type { DestinationProps } from './index';

// Adapter from the shared destination contract to the launch brief surface.
export default function LaunchDestination(props: DestinationProps) {
  const workspaceName = () => {
    const entry = props.catalog.find(item => String(item.id) === String(props.route.ws));
    return String(entry?.name || entry?.id || props.route.ws || '');
  };
  return (
    <Launch
      route={props.route}
      live={props.live}
      token={props.token}
      workspace={props.workspace}
      workspaceError={props.workspaceError}
      workspaceName={workspaceName()}
      assignments={props.assignments}
      records={props.records}
      observationLoaded={props.payload != null}
      epics={props.epics}
      onNavigate={props.onNavigate}
      onReturnToAgents={() => props.onNavigate({ dest: 'agents', ...(props.route.ws !== undefined ? { ws: props.route.ws } : {}) })}
    />
  );
}

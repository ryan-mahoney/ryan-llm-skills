import type { Component } from 'solid-js';
import type { AgentCoverage } from '../agent-state';
import type { Envelope, Observer, WireRecord } from '../model';
import type { Destination, RouteState } from '../route';
import type { CatalogEntry } from '../scope';
import SpecsDestination from './specs';
import EpicsDestination from './epics';
import AgentsDestination from './agents';
import ConversationsDestination from './conversations';
import FilesDestination from './files';
import DesignsDestination from './designs';
import { WorkspacesDestination } from './workspaces';
import LaunchDestination from './launch';
import ModelsDestination from './models';

export type DestinationProps = {
  route: RouteState;
  payload: Envelope | null;
  live: boolean;
  specsLive: boolean;
  records: WireRecord[];
  assignments: WireRecord[];
  epics: WireRecord[];
  scopedObservers: Observer[];
  epicSupport?: string | null;
  // Agents-only retained selection and resolved observation coverage; sibling
  // adapters keep their existing required props unchanged.
  agentsSelected?: WireRecord | null;
  agentsSelectionRetained?: boolean;
  agentsCoverage?: AgentCoverage | null;
  catalog: CatalogEntry[];
  catalogInvalid: WireRecord[];
  catalogStorage?: WireRecord;
  catalogError: string;
  storageDiagnostics: { message: string; path?: string }[];
  workspace?: WireRecord;
  workspaceError: string;
  token?: string;
  completionToken?: string;
  completionLocalOnly?: boolean;
  refreshKey: number;
  refresh: () => Promise<void>;
  onNavigate: (next: RouteState) => void;
  catalogLoaded: boolean;
  catalogPending: boolean;
  workspacePending: boolean;
  catalogDelayed: boolean;
  workspaceDelayed: boolean;
  connectionFailed: boolean;
  catalogLoadedAt: number | null;
  workspaceLoadedAt: number | null;
  onSelect: (id: string) => void;
  onQuery: (value: string) => void;
  onFilter: (value: string) => void;
  onOpenFile: (path: string) => void;
  onCompletionRecorded: (record: WireRecord) => void;
  onEnded: (id: string) => void;
  onSelectPackage: (workspace: string, name: string) => void;
  onOpenPackageFiles: (record: WireRecord, path?: string) => void;
  canOpenPackageFiles: (record: WireRecord) => boolean;
  onRetryWorkspace: (id: string) => void;
  onRetryCatalog: () => void;
  onRetryConnection: () => void;
  onChooseWorkspace: (id: string) => void;
};

export type DestinationNav = 'primary' | 'directory' | 'hidden';

export type DestinationEntry = {
  dest: Destination;
  label: string;
  order: number;
  nav: DestinationNav;
  parent?: Destination;
  render: Component<DestinationProps>;
};

// Rail order reserves 0 for the unrendered Next steps entry; primary
// destinations therefore start at 10 and continue in tens through 60.
// Workspaces takes 70 and Models takes 80.
export function destinationEntries(): DestinationEntry[] {
  return [
    { dest: 'specs', label: 'Specs', order: 10, nav: 'primary', render: SpecsDestination },
    { dest: 'epics', label: 'Epics', order: 20, nav: 'primary', render: EpicsDestination },
    { dest: 'agents', label: 'Agents', order: 30, nav: 'primary', render: AgentsDestination },
    { dest: 'conversations', label: 'Conversations', order: 40, nav: 'primary', render: ConversationsDestination },
    { dest: 'files', label: 'Files', order: 50, nav: 'primary', render: FilesDestination },
    { dest: 'designs', label: 'Designs', order: 60, nav: 'primary', render: DesignsDestination },
    { dest: 'workspaces', label: 'Workspaces', order: 70, nav: 'directory', render: WorkspacesDestination },
    { dest: 'models', label: 'Models', order: 80, nav: 'directory', render: ModelsDestination },
    // Launch is a hidden Agents-child flow: it adds no rail entry, and the
    // Shell highlights Agents while it is open.
    { dest: 'launch', label: 'Launch agent', order: 35, nav: 'hidden', parent: 'agents', render: LaunchDestination },
  ];
}

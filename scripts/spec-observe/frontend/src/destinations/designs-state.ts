// Designs domain owner: pure selection of design/screen/width from the route
// plus the safe brief link into the workspace Files view.
//
// selectDesign resolves against the unfiltered index; q filters rows in the
// caller and never changes the selection. The caller pushes explicit choices
// and applies a non-null `normalized` route with a replace navigation.
import { safeRelativeFilePath, type RouteState } from '../route';

export type Screen = {
  step: number;
  file: string;
  title: string;
  person: string;
  job: string;
  produced: boolean;
  captured: Record<string, boolean>;
  primary_action?: string | null;
  notes?: string | null;
  kind: string;
  state: string;
  shell_from?: number | null;
};

export type Deviation = { screen: number; token: string; from: string; to: string; reason: string };

export type Design = {
  slug: string;
  path: string;
  title: string;
  brief?: string | null;
  viewport: { posture: string; widths: number[] };
  summary: { total: number; produced: number; captured: number };
  screens: Screen[];
  deviations?: Deviation[];
};

export type DesignsResponse = { designs: Design[]; errors?: { name: string; message: string }[] };

export type DesignSelection = {
  design: Design | null;
  screen: Screen | null;
  width: number | null;
  unavailable: boolean;
  normalized: RouteState | null;
};

const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function selectDesign(route: RouteState, designs: Design[]): DesignSelection {
  const requested = text(route.id);
  const design = requested ? designs.find(candidate => candidate.slug === requested) ?? null : designs[0] ?? null;
  if (!design) return { design: null, screen: null, width: null, unavailable: true, normalized: null };
  const path = text(route.path);
  const screens = design.screens ?? [];
  const screen = (path ? screens.find(candidate => candidate.file === path) : undefined)
    ?? screens.find(candidate => candidate.produced)
    ?? screens[0]
    ?? null;
  const tab = text(route.tab);
  const widths = design.viewport?.widths ?? [];
  const width = (tab ? widths.find(candidate => String(candidate) === tab) : undefined)
    ?? widths[0]
    ?? null;
  const canonicalTab = width === null ? '' : String(width);
  const canonical = requested === design.slug && path === (screen?.file ?? '') && tab === canonicalTab;
  return {
    design, screen, width, unavailable: false,
    normalized: canonical ? null
      : { dest: 'designs', ws: route.ws, q: route.q, id: design.slug, path: screen?.file, tab: width === null ? undefined : canonicalTab },
  };
}

export function designBriefRoute(ws: string, design: Design): RouteState | null {
  if (typeof ws !== 'string' || ws === '' || !safeRelativeFilePath(design.brief)) return null;
  return { dest: 'files', ws, source: 'workspace', path: `${design.path}/${design.brief}` };
}

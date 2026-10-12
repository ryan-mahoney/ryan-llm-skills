// Adapted from Re-Story's composerTypes.ts: canonical selections travel
// separately from the text. Solid uses a native textarea rather than Slate atoms.
export type TriggerItem = { kind: 'skill' | 'file'; id: string; label: string; description?: string; source?: string; path?: string };
export type BriefReference = TriggerItem & { token: string };
export type ReferenceIdentity = Pick<TriggerItem, 'kind' | 'id'>;
export const identities = (refs: BriefReference[]): ReferenceIdentity[] => refs.map(({kind,id}) => ({kind,id}));
export type InputPreview = { brief: string; instruction: string; references: Array<TriggerItem & { content: string; sha256: string; base_dir?: string }> };

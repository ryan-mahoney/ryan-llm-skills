import { installContextBudget } from './policy.mjs';
import { compact, convertToLlm, serializeConversation, SettingsManager } from '@earendil-works/pi-coding-agent';

export default function (pi: any) {
  installContextBudget(pi, { compact,
    serialize: (messages: any[]) => serializeConversation(convertToLlm(messages)),
    retrySettings: () => SettingsManager.inMemory(pi.getSettings()).getRetrySettings() });
}

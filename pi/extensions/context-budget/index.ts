import { installContextBudget } from './policy.mjs';
import { compact, SettingsManager } from '@earendil-works/pi-coding-agent';

export default function (pi: any) {
  installContextBudget(pi, { compact,
    retrySettings: () => SettingsManager.inMemory(pi.getSettings()).getRetrySettings() });
}

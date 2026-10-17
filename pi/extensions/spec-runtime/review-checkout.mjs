import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A background serial review sees its pinned commit while the next step can
// edit the integration checkout. No branch or package location is rewritten.
export function prepareReviewCheckout(source, head) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Review requires a full pinned commit SHA');
  const checkout = mkdtempSync(join(tmpdir(), 'spec-review-'));
  let registered = false;
  try {
    execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', checkout, head], { stdio: 'pipe' });
    registered = true;
    if (existsSync(join(source, 'node_modules')) && !existsSync(join(checkout, 'node_modules')))
      symlinkSync(join(source, 'node_modules'), join(checkout, 'node_modules'));
    return { source, checkout, head };
  } catch (error) {
    if (registered) {
      try { removeReviewCheckout({ source, checkout }); }
      catch (cleanupError) { error.message += `; review checkout cleanup failed: ${cleanupError.message}`; throw error; }
    } else rmSync(checkout, { recursive: true, force: true });
    throw error;
  }
}

export function removeReviewCheckout(binding) {
  execFileSync('git', ['-C', binding.source, 'worktree', 'remove', '--force', binding.checkout], { stdio: 'pipe' });
}

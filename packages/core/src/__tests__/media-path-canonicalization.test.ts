/** Real owned-file path policy fixtures; no media binary or application runs. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MediaManager } from '../media/manager.js';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  // A hidden, owned directory avoids the intentionally trusted OS temp
  // directory and never reads or writes any pre-existing home contents.
  const root = mkdtempSync(join(homedir(), '.agenticmail-owned-media-test-'));
  fixtures.push(root);
  const allowed = join(root, 'allowed');
  const privateDir = join(root, 'private');
  mkdirSync(allowed); mkdirSync(privateDir);
  const manager = new MediaManager({ outputDir: allowed });
  const check = (path: string) => (manager as unknown as { inputPath(path: string): string }).inputPath(path);
  return { root, allowed, privateDir, check };
}

describe.skipIf(process.platform === 'win32')('media canonical input containment', () => {
  it('rejects an allowed-directory symlink to an owned hidden-home file', () => {
    const { allowed, privateDir, check } = fixture();
    const target = join(privateDir, 'synthetic.txt'); writeFileSync(target, 'synthetic');
    const alias = join(allowed, 'visible.txt'); symlinkSync(target, alias);
    expect(() => check(target)).toThrow(/outside the allowed/);
    expect(() => check(alias)).toThrow(/outside the allowed/);
  });
  it('accepts configured symlink-root aliases and returns the canonical existing input', () => {
    const { root, allowed } = fixture();
    const alias = join(root, 'configured-root'); symlinkSync(allowed, alias, 'dir');
    const target = join(allowed, 'synthetic.txt'); writeFileSync(target, 'synthetic');
    const manager = new MediaManager({ outputDir: join(root, 'not-created'), inputRoots: [alias] });
    const check = (path: string) => (manager as unknown as { inputPath(path: string): string }).inputPath(path);
    expect(check(join(alias, 'synthetic.txt'))).toBe(realpathSync(target));
    expect(check(target)).toBe(realpathSync(target));
  });
  it('rejects nonexistent and dangling inputs before returning a path', () => {
    const { allowed, check } = fixture();
    const missing = join(allowed, 'missing.txt');
    const dangling = join(allowed, 'dangling.txt'); symlinkSync(missing, dangling);
    expect(() => check(missing)).toThrow(/file not found/);
    expect(() => check(dangling)).toThrow(/file not found/);
  });
});

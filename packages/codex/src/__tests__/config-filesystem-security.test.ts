/** Filesystem-only fixtures: no dispatcher, API, provider or mailbox activity. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';

const roots = vi.hoisted(() => ({ home: '', tmp: '' }));
const io = vi.hoisted(() => ({ failWrite: false, failRename: false, modesBeforeWrite: [] as number[], scratchCalls: 0, writeCalls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      io.scratchCalls++;
      return actual.mkdtempSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      io.writeCalls++;
      if (typeof args[0] === 'number') {
        io.modesBeforeWrite.push(actual.fstatSync(args[0]).mode & 0o777);
        if (io.failWrite) throw new Error('synthetic write failure');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (io.failRename) throw new Error('synthetic publication failure');
      return actual.renameSync(...args);
    },
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => roots.home, tmpdir: () => roots.tmp };
});
const realOs = await vi.importActual<typeof import('node:os')>('node:os');
import { readCodexConfig, writeCodexConfig } from '../codex-config-toml.js';
import { upsertMailHook } from '../codex-hooks-config.js';

let base: string;
beforeEach(() => {
  io.failWrite = false; io.failRename = false; io.modesBeforeWrite = [];
  base = fs.mkdtempSync(join(realOs.tmpdir(), 'am-config-fs-'));
  roots.home = join(base, 'home');
  roots.tmp = join(base, 'tmp');
  fs.mkdirSync(roots.home);
  fs.mkdirSync(roots.tmp);
  fs.mkdirSync(join(base, 'outside'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

const writers = [
  { name: 'TOML', file: 'config.toml', write: (path: string, changed = false) => writeCodexConfig(path, { model: changed ? 'fixture-new' : 'fixture', mcp_servers: { test: { env: { FIXTURE_KEY: 'not-a-real-key' } } } }) },
  { name: 'hooks', file: 'hooks.json', write: (path: string, changed = false) => upsertMailHook(path, changed ? 'node /fixture/mail-hook.js' : 'agenticmail-codex-mail-hook') },
];

for (const writer of writers) {
  describe(`${writer.name} private contained writes`, () => {
    it.skipIf(process.platform === 'win32')('refuses symlinked ancestors and target files escaping trusted roots', () => {
      const outside = join(base, 'outside');
      const link = join(roots.home, 'escape');
      fs.symlinkSync(outside, link, 'dir');
      const target = join(outside, writer.file);
      fs.writeFileSync(target, 'untouched');
      expect(() => writer.write(join(link, writer.file))).toThrow(/outside of HOME or tmp/);
      fs.symlinkSync(target, join(roots.tmp, writer.file));
      expect(() => writer.write(join(roots.tmp, writer.file))).toThrow(/outside of HOME or tmp/);
      expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
      expect(fs.readdirSync(outside)).toEqual([writer.file]);
    });

    it.skipIf(process.platform === 'win32')('preserves a trusted internal alias and resolves missing nested parents', () => {
      const actual = join(roots.home, 'actual');
      fs.mkdirSync(actual);
      const alias = join(roots.home, 'alias');
      fs.symlinkSync(actual, alias, 'dir');
      writer.write(join(alias, 'nested', writer.file));
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.statSync(join(actual, 'nested', writer.file)).isFile()).toBe(true);
      expect(fs.readdirSync(join(actual, 'nested'))).toEqual([writer.file]);
    });

    it.skipIf(process.platform === 'win32')('writes through an allowed existing file alias without replacing the alias', () => {
      const actual = join(roots.home, writer.file);
      writer.write(actual);
      const alias = join(roots.tmp, `alias-${writer.file}`);
      fs.symlinkSync(actual, alias);
      writer.write(alias, true);
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(actual, 'utf8')).toBe(fs.readFileSync(alias, 'utf8'));
    });

    it.skipIf(process.platform === 'win32')('accepts the canonical target of a trusted temp-root alias', () => {
      const actualTmp = join(base, 'canonical-tmp');
      fs.mkdirSync(actualTmp);
      const alias = join(base, 'tmp-root-alias');
      fs.symlinkSync(actualTmp, alias, 'dir');
      roots.tmp = alias;
      writer.write(join(actualTmp, writer.file));
      expect(fs.statSync(join(actualTmp, writer.file)).isFile()).toBe(true);
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    });

    it('rejects existing directories and trusted roots before creating any scratch artifact', () => {
      const nested = join(roots.home, 'directory');
      fs.mkdirSync(nested);
      const beforeBase = fs.readdirSync(base).sort();
      const beforeHome = fs.readdirSync(roots.home).sort();
      const beforeScratchCalls = io.scratchCalls;
      const beforeWriteCalls = io.writeCalls;
      for (const destination of [roots.home, roots.tmp, nested]) {
        expect(() => writer.write(destination)).toThrow(/path must be a file/);
      }
      expect(fs.readdirSync(base).sort()).toEqual(beforeBase);
      expect(fs.readdirSync(roots.home).sort()).toEqual(beforeHome);
      expect(fs.readdirSync(roots.tmp)).toEqual([]);
      expect(io.modesBeforeWrite).toEqual([]);
      expect(io.scratchCalls).toBe(beforeScratchCalls);
      expect(io.writeCalls).toBe(beforeWriteCalls);
    });

    it('does not touch the historical predictable temporary path', () => {
      const target = join(roots.home, writer.file);
      const oldTemporary = `${target}.agenticmail-tmp`;
      fs.writeFileSync(oldTemporary, 'other-owner-sentinel');
      writer.write(target);
      expect(fs.readFileSync(oldTemporary, 'utf8')).toBe('other-owner-sentinel');
      expect(fs.readdirSync(roots.home).sort()).toEqual([writer.file, `${writer.file}.agenticmail-tmp`].sort());
    });

    it.skipIf(process.platform === 'win32')('creates private mode before exposing bytes and replaces permissive old mode', () => {
      const target = join(roots.home, writer.file);
      writer.write(target);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      fs.chmodSync(target, 0o644);
      writer.write(target, true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(io.modesBeforeWrite.length).toBeGreaterThanOrEqual(2);
      expect(io.modesBeforeWrite.every(mode => mode === 0o600)).toBe(true);
    });

    for (const phase of ['write', 'publication'] as const) {
      it(`preserves old bytes and removes scratch space on ${phase} failure`, () => {
        const target = join(roots.home, writer.file);
        writer.write(target);
        const before = fs.readFileSync(target, 'utf8');
        io.failWrite = phase === 'write';
        io.failRename = phase === 'publication';
        expect(() => writer.write(target, true)).toThrow(/synthetic/);
        expect(fs.readFileSync(target, 'utf8')).toBe(before);
        expect(fs.readdirSync(roots.home)).toEqual([writer.file]);
      });
    }
  });
}

it.skipIf(process.platform === 'win32')('refuses a config read through an escaping symlink', () => {
  const outside = join(base, 'outside', 'config.toml');
  fs.writeFileSync(outside, 'model = "private-fixture"\n');
  const alias = join(roots.home, 'config.toml');
  fs.symlinkSync(outside, alias);
  expect(() => readCodexConfig(alias)).toThrow(/outside of HOME or tmp/);
});

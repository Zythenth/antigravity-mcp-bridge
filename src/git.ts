import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { GitSnapshot } from './types.js';

async function git(cwd: string, args: string[], maxBytes = 1_000_000): Promise<{ ok: boolean; output: string; truncated: boolean }> {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', truncated = false;
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > maxBytes) truncated = true;
      output = (output + chunk.toString('utf8')).slice(0, maxBytes);
    });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, output: '', truncated: false }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output, truncated }); });
  });
}

export async function gitSnapshot(cwd: string): Promise<GitSnapshot | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], 4096);
  if (!top.ok) return undefined;
  const [branch, status, diff, diffStat] = await Promise.all([
    git(cwd, ['branch', '--show-current'], 4096),
    git(cwd, ['status', '--short', '--branch'], 200000),
    git(cwd, ['diff', '--no-ext-diff'], 1_000_000),
    git(cwd, ['diff', '--stat', '--no-ext-diff'], 200000),
  ]);
  return { branch: branch.output.trim(), status: status.output, diff: diff.output, diffStat: diffStat.output,
    truncated: status.truncated || diff.truncated || diffStat.truncated };
}

export async function createWorktree(cwd: string): Promise<string> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], 4096);
  if (!top.ok) throw new Error('Worktree isolation requires a Git repository');
  const dirty = await git(cwd, ['status', '--porcelain'], 200000);
  if (!dirty.ok || dirty.output.trim()) throw new Error('Worktree isolation requires a clean Git working tree');
  const parent = path.join(os.tmpdir(), 'agy-mcp-worktrees');
  await mkdir(parent, { recursive: true });
  const target = path.join(parent, randomUUID());
  const created = await git(cwd, ['worktree', 'add', '--detach', target, 'HEAD']);
  if (!created.ok) throw new Error('git worktree add failed');
  return target;
}

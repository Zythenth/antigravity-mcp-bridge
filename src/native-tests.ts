import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './types.js';
import type { ProjectCopy } from './isolation.js';

export const testCommandSchema = z.object({
  executable: z.string().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(50).default([]),
}).strict();
export type TestCommand = z.infer<typeof testCommandSchema>;
export interface NativeTestRequest extends TestCommand { expectedSha256: string; maxAttempts: number }
export const receiptSchema = z.object({
  nonce: z.string().uuid(), exitCode: z.number().int().min(0).max(255).nullable(),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  error: z.string().optional(), truncated: z.boolean(),
}).strict();
export type NativeTestReceipt = z.infer<typeof receiptSchema>;

async function nativeRunner(settings: TestCommand & { nonce: string; copyDirectory: string; file: string; timeoutSeconds: number; maxCopyFiles: number; maxCopyBytes: number }) {
  const fs = require('node:fs') as typeof import('node:fs');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const paths = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const processes = require('node:child_process') as typeof import('node:child_process');
  const receipt: NativeTestReceipt = { nonce: settings.nonce, exitCode: null, truncated: false };
  const gitDirectory = fs.mkdtempSync(paths.join(os.tmpdir(), 'agy-test-snapshot-'));
  let output = '';
  try {
    if (paths.relative(fs.realpathSync.native(settings.copyDirectory), fs.realpathSync.native(process.cwd())) !== '') throw new Error('Test working directory differs from the copy');
    processes.execFileSync('git', ['-c', 'init.templateDir=', 'init', '--bare', '--quiet', gitDirectory]);
    fs.mkdirSync(paths.join(gitDirectory, 'info'), { recursive: true });
    fs.appendFileSync(paths.join(gitDirectory, 'info', 'exclude'), '\n/' + settings.file + '\n');
    async function fingerprint() {
      const list = processes.execFileSync('git', ['--git-dir=' + gitDirectory, '--work-tree=' + process.cwd(), 'ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 10_000_000 }).toString('utf8').split('\0').filter(Boolean).sort();
      if (list.length > settings.maxCopyFiles) throw new Error('Test snapshot file limit exceeded');
      const tree = crypto.createHash('sha256');
      let bytes = 0;
      for (const relative of list) {
        let current = process.cwd();
        for (const part of relative.split('/')) {
          if (!part || part === '..' || part === '.' || part === '.git') throw new Error('Unsafe test path');
          current = paths.join(current, part);
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Test snapshot contains a link');
        }
        if (!fs.lstatSync(current).isFile()) throw new Error('Test snapshot contains a non-file');
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(current)) {
          bytes += chunk.length;
          if (bytes > settings.maxCopyBytes) throw new Error('Test snapshot byte limit exceeded');
          hash.update(chunk);
        }
        tree.update(relative + '\0' + hash.digest('hex') + '\0');
      }
      return tree.digest('hex');
    }
    receipt.beforeSha256 = await fingerprint();
    let executable = settings.executable, args = settings.args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
      if (args.some(arg => /[&|<>^()%!"\r\n]/.test(arg))) throw new Error('Batch arguments contain unsupported shell metacharacters; use a native executable');
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const script = "$ErrorActionPreference='Stop'; try { $global:LASTEXITCODE=0; & (Get-Command -Name " + quote(executable) + " -CommandType Application -ErrorAction Stop).Source " + args.map(quote).join(' ') + "; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 127 }";
      executable = paths.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    }
    const child = processes.spawn(executable, args, { cwd: process.cwd(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (output.length + text.length > 4000) receipt.truncated = true;
      output = (output + text).slice(-4000);
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { receipt.error = 'Command timed out'; child.kill(); }, settings.timeoutSeconds * 1000);
    child.once('error', error => { receipt.error = error.message; });
    receipt.exitCode = await new Promise<number | null>(resolve => child.once('close', resolve));
    clearTimeout(timer);
    receipt.afterSha256 = await fingerprint();
  } catch (error) { receipt.error = error instanceof Error ? error.message : String(error); }
  finally {
    if (paths.dirname(paths.resolve(gitDirectory)) !== paths.resolve(os.tmpdir()) || !paths.basename(gitDirectory).startsWith('agy-test-snapshot-') || fs.lstatSync(gitDirectory).isSymbolicLink()) throw new Error('Unsafe snapshot cleanup path');
    fs.rmSync(gitDirectory, { recursive: true, force: true });
  }
  process.stdout.write(output + '\nAGY_BRIDGE_TEST:' + settings.nonce + ':' + Buffer.from(JSON.stringify(receipt)).toString('base64') + '\n');
}

export async function prepareNativeTest(project: ProjectCopy, request: NativeTestRequest, settings: { timeoutSeconds: number; maxCopyFiles: number; maxCopyBytes: number }) {
  testCommandSchema.parse({ executable: request.executable, args: request.args });
  const nonce = randomUUID();
  const file = '.agy-bridge-test-' + nonce + '.cjs';
  const absolute = path.join(project.copyDirectory, file);
  const script = '(' + nativeRunner.toString() + ')(' + JSON.stringify({ executable: request.executable, args: request.args, nonce, file, copyDirectory: project.copyDirectory, ...settings }) + ');';
  const hash = createHash('sha256').update(script).digest('hex');
  const exclude = path.join(project.gitDirectory, 'info', 'exclude');
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, '\n/' + file + '\n');
  await writeFile(absolute, script, { flag: 'wx', mode: 0o600 });
  const bootstrap = "const fs=require('node:fs'),c=require('node:crypto'),b=fs.readFileSync('" + file +
    "');if(c.createHash('sha256').update(b).digest('hex')!=='" + hash + "')throw Error('TestRunnerChanged');Function('require',b.toString())(require);";
  let commandLine;
  if (process.platform === 'win32') {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    commandLine = '& ' + quote(process.execPath) + ' -e ' + quote(bootstrap);
  } else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    commandLine = quote(process.execPath) + ' -e ' + quote(bootstrap);
  }
  if (commandLine.length > 30000) throw new BridgeError('INVALID_TEST_COMMAND', 'Test command exceeds the process argument limit');
  return { nonce, commandLine,
    prompt: 'Execute this exact CommandLine with run_command in the current copy, inside the native sandbox: ' + JSON.stringify(commandLine) +
      '. Do not replace, edit or summarize its execution. The runner prints the actual command output and a receipt. Maximum attempts: ' + request.maxAttempts +
      '. Only after a nonzero command receipt, make relevant fixes and retry the same CommandLine if attempts remain. Do not run outside the sandbox, change the runner, weaken tests, or claim success without the receipt. Stop when the command passes or attempts are exhausted.' +
      '\n<bridge-test-command>' + JSON.stringify({ commandLine, maxAttempts: request.maxAttempts }) + '</bridge-test-command>',
    async cleanup() {
      await rm(absolute, { force: true });
      const content = await readFile(exclude, 'utf8');
      await writeFile(exclude, content.split(/\r?\n/).filter(line => line !== '/' + file).join('\n'));
    },
  };
}

export function readNativeReceipt(step: Record<string, unknown>, expected: { nonce: string; commandLine: string }): { receipt: NativeTestReceipt; output: string } | undefined {
  if (step.state !== 'DONE' || step.step_type !== 'tool' || step.tool_name !== 'run_command') return;
  const info = step.tool_info as { parameters?: { CommandLine?: unknown }; output?: unknown } | undefined;
  if (info?.parameters?.CommandLine !== expected.commandLine || typeof info.output !== 'string') return;
  const prefix = 'AGY_BRIDGE_TEST:' + expected.nonce + ':';
  const lines = info.output.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return;
  try {
    const receipt = receiptSchema.parse(JSON.parse(Buffer.from(lines[0]!.slice(prefix.length), 'base64').toString('utf8')));
    if (receipt.nonce !== expected.nonce) return;
    return { receipt, output: info.output.slice(0, info.output.indexOf(prefix)).trim().slice(-4000) };
  } catch { return; }
}

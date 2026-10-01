import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError, type RunOptions } from './types.js';
import type { Config } from './config.js';
import { roleContract } from './roles.js';
import { validatePrompt } from './validation.js';

interface ProbeResult { code: number | null; stdout: string; stderr: string }
export interface Model { id: string; name: string }
export interface Discovery {
  installed: boolean;
  path: string;
  version?: string;
  authenticated: boolean | null;
  capabilities: { structuredOutput: boolean; streaming: boolean; sandbox: boolean; readOnlyMode: boolean; models: boolean; modelSelection: boolean; resume: boolean; sessionsList: boolean; cancel: boolean };
  error?: string;
}

function isAuthError(message: string): boolean {
  return /authentication required|not logged in|not logged into|login required|please log in/i.test(message);
}

async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command)) return path.resolve(command);
  const extensions = process.platform === 'win32' ? ['', '.exe'] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try { await access(candidate); return candidate; } catch { /* continue searching PATH */ }
    }
  }
  return command;
}

export class CliAdapter {
  private help = '';
  private version?: string;
  private installed = false;
  constructor(private readonly config: Config, private readonly prefixArgs: string[] = []) {}

  private probe(args: string[], timeoutMs = 10000): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.agyPath, [...this.prefixArgs, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-2_000_000); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-100_000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  async discover(): Promise<Discovery> {
    try {
      const [version, help] = await Promise.all([this.probe(['--version']), this.probe(['--help'])]);
      this.version = (version.stdout || version.stderr).trim() || undefined;
      this.help = help.stdout + '\n' + help.stderr;
      this.installed = true;
      const streaming = this.help.includes('stream-json') && this.help.includes('--output-format');
      return {
        installed: true, path: await resolveExecutable(this.config.agyPath), version: this.version, authenticated: null,
        capabilities: {
          structuredOutput: streaming, streaming, sandbox: this.help.includes('--sandbox'),
          readOnlyMode: this.help.includes('--mode') && this.help.includes('plan'),
          models: this.help.includes('models'), modelSelection: this.help.includes('--model'),
          resume: this.help.includes('--conversation'), sessionsList: false, cancel: false,
        },
      };
    } catch (error) {
      this.installed = false;
      return { installed: false, path: this.config.agyPath, authenticated: null,
        capabilities: { structuredOutput: false, streaming: false, sandbox: false, readOnlyMode: false, models: false, modelSelection: false, resume: false, sessionsList: false, cancel: false },
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  async health(): Promise<Discovery> {
    const discovery = await this.discover();
    if (!discovery.installed || !discovery.capabilities.models) return discovery;
    try {
      discovery.authenticated = (await this.listModels()).length > 0;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'AGY_AUTH_REQUIRED') discovery.authenticated = false;
      else discovery.error = error instanceof Error ? error.message : String(error);
    }
    return discovery;
  }

  async listModels(): Promise<Model[]> {
    let result: ProbeResult;
    try { result = await this.probe(['models'], 20000); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BridgeError('AGY_NOT_FOUND', 'agy executable not found');
      throw new BridgeError('AGY_PROCESS_FAILED', error instanceof Error ? error.message : String(error));
    }
    if (isAuthError(result.stdout + result.stderr)) throw new BridgeError('AGY_AUTH_REQUIRED', 'Authenticate with the official interactive `agy` command');
    if (result.code !== 0) throw new BridgeError('AGY_PROCESS_FAILED', `agy models exited ${result.code}`);
    const models = result.stdout.split(/\r?\n/).map(line => line.trim().match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ id: match[1]!, name: match[2]!.trim() }));
    if (models.length === 0) throw new BridgeError('AGY_AUTH_REQUIRED', 'No models returned; authenticate with the official interactive `agy` command');
    return models;
  }

  spawnTask(options: RunOptions, model: string | undefined, cwd: string): ChildProcessWithoutNullStreams {
    if (!this.installed) throw new BridgeError('AGY_NOT_FOUND', 'agy executable not found');
    if (!this.help.includes('stream-json')) throw new BridgeError('AGY_CAPABILITY_UNAVAILABLE', 'Installed agy does not advertise stream-json');
    if (!this.help.includes('--sandbox')) throw new BridgeError('AGY_CAPABILITY_UNAVAILABLE', 'Installed agy does not advertise --sandbox');
    const args = ['--sandbox', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', `${options.timeoutSeconds ?? this.config.defaultTimeoutSeconds}s`];
    if (this.help.includes('--add-dir')) args.push('--add-dir', cwd);
    if (!options.sessionId && this.help.includes('--new-project')) args.push('--new-project');
    if (options.mode === 'read-only') {
      if (!this.help.includes('--mode') || !this.help.includes('plan')) throw new BridgeError('AGY_CAPABILITY_UNAVAILABLE', 'Installed agy does not advertise plan mode');
      args.push('--mode', 'plan');
    }
    if (model) args.push('--model', model);
    if (options.sessionId) args.push('--conversation', options.sessionId);
    const contract = roleContract(options.role ?? 'implementer');
    if (contract) {
      if (!this.help.includes('--json-schema')) throw new BridgeError('AGY_CAPABILITY_UNAVAILABLE', 'Structured roles require agy --json-schema');
      args.push('--json-schema', JSON.stringify(contract.schema));
    }
    const instructions = '\n\n<bridge-verification>\nInspect actual files before claiming changes. Report changed paths and evidence. Never claim a command or test ran without observed output and exit status. Distinguish completed work, failed work and unverified work. CLI SUCCESS only means execution ended; Codex will independently inspect the patch and acceptance criteria.\nAcceptance criteria: ' + JSON.stringify(options.acceptanceCriteria || []) + '\n</bridge-verification>';
    const content = options.prompt + instructions + (contract ? '\n' + contract.instruction : '');
    validatePrompt(content, this.config.maxPromptChars);
    const child = spawn(this.config.agyPath, [...this.prefixArgs, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify({ event: 'user', message: { content } }) + '\n');
    return child;
  }

  static authError(message: string): boolean { return isAuthError(message); }
}

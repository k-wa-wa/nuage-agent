import { spawn } from 'child_process';
import { logger } from './logger.js';

export interface RunCommandOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * @what 指定されたコマンドを子プロセスとして実行し、標準出力・標準エラー出力・終了コードを取得します。
 * @why 各種エージェント（Claude Code 等）や git/gh CLI コマンドを、ディレクトリや環境変数を適切に指定した状態で、非同期かつストリーミング処理で安全に実行するため。
 */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { cmd, args, cwd, env } = options;

  logger.info(`Executing CLI: ${cmd} ${args.join(' ')}`, 'runner');

  return new Promise((resolve, reject) => {
    // We expand home directory (~) if present in the command path
    const normalizedCmd = cmd.startsWith('~/') ? cmd.replace('~', process.env.HOME ?? '') : cmd;

    const child = spawn(normalizedCmd, args, {
      cwd,
      shell: false, // Turn off shell to prevent DEP0190 and escaping issues
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      // Output CLI progress in real-time
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // Output CLI error progress in real-time
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      logger.info(`CLI process exited with code ${code}`, 'runner');
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      logger.error(`CLI Process error: ${err.message}`, 'runner');
      reject(err);
    });
  });
}

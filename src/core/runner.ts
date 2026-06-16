import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

export interface RunCommandOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logFilePath?: string;
  silentStdout?: boolean;
  onProgress?: (line: string) => void;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * @what 指定されたコマンドを子プロセスとして実行し、標準出力・標準エラー出力・終了コードを取得します。
 * @why 各種エージェント（Claude Code 等）や git/gh CLI コマ著を、ディレクトリや環境変数を適切に指定した状態で、非同期かつストリーミング処理で安全に実行するため。
 */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { cmd, args, cwd, env, logFilePath, silentStdout, onProgress } = options;

  logger.info(`Executing CLI: ${cmd} ${args.join(' ')}`, 'runner');

  return new Promise((resolve, reject) => {
    // We expand home directory (~) if present in the command path
    const normalizedCmd = cmd.startsWith('~/') ? cmd.replace('~', process.env.HOME ?? '') : cmd;

    let logFileStream: fs.WriteStream | undefined;
    if (logFilePath) {
      try {
        const dir = path.dirname(logFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
      } catch (err) {
        logger.error(`Failed to create log file stream at ${logFilePath}`, 'runner', err);
      }
    }

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
    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      if (logFileStream) {
        logFileStream.write(chunk);
      }
      if (!silentStdout) {
        process.stdout.write(chunk);
      }

      if (onProgress) {
        stdoutBuffer += chunk;
        let lineEndIndex;
        while ((lineEndIndex = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, lineEndIndex);
          stdoutBuffer = stdoutBuffer.slice(lineEndIndex + 1);
          onProgress(line);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;

      if (logFileStream) {
        logFileStream.write(chunk);
      }
      if (!silentStdout) {
        process.stderr.write(chunk);
      }

      if (onProgress) {
        stderrBuffer += chunk;
        let lineEndIndex;
        while ((lineEndIndex = stderrBuffer.indexOf('\n')) !== -1) {
          const line = stderrBuffer.slice(0, lineEndIndex);
          stderrBuffer = stderrBuffer.slice(lineEndIndex + 1);
          onProgress(line);
        }
      }
    });

    child.on('close', (code) => {
      if (logFileStream) {
        logFileStream.end();
      }
      logger.info(`CLI process exited with code ${code}`, 'runner');
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      if (logFileStream) {
        logFileStream.end();
      }
      logger.error(`CLI Process error: ${err.message}`, 'runner');
      reject(err);
    });
  });
}

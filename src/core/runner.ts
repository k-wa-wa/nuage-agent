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
 * @what ログ保存用の書き込みファイルストリームを作成します。
 * @why 指定パスの親ディレクトリがなければ自動生成し、安全に追記モードで開くため。
 */
function createLogStream(logFilePath?: string): fs.WriteStream | undefined {
  if (!logFilePath) {
    return undefined;
  }
  try {
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fs.createWriteStream(logFilePath, { flags: 'a' });
  } catch (err) {
    logger.error(`Failed to create log file stream at ${logFilePath}`, 'runner', err);
  }
  return undefined;
}

/**
 * @what 子プロセスのストリーム出力（stdout/stderr）を受け取り、バッファリングと進行状況コールバック処理を行います。
 * @why 行バッファを管理し、Thinking/Calling toolなどのキー情報をリアルタイムに進捗出力するため。
 */
function handleStreamData(
  data: Buffer,
  state: { content: string; buffer: string },
  options: {
    logStream?: fs.WriteStream;
    silentStdout?: boolean;
    onProgress?: (line: string) => void;
    isStderr: boolean;
  },
): void {
  const chunk = data.toString();
  state.content += chunk;

  if (options.logStream) {
    options.logStream.write(chunk);
  }
  if (options.silentStdout === false) {
    if (options.isStderr) {
      process.stderr.write(chunk);
    } else {
      process.stdout.write(chunk);
    }
  }

  if (options.onProgress) {
    state.buffer += chunk;
    let lineEndIndex;
    while ((lineEndIndex = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, lineEndIndex);
      state.buffer = state.buffer.slice(lineEndIndex + 1);
      options.onProgress(line);
    }
  }
}

/**
 * @what 指定されたコマンドを子プロセスとして実行し、標準出力・標準エラー出力・終了コードを取得します。
 * @why 各種エージェントや git/gh CLI コマンドを、非同期かつストリーミング処理で安全に実行するため。
 */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { cmd, args, cwd, env, logFilePath, silentStdout, onProgress } = options;
  logger.info(`Executing CLI: ${cmd} ${args.join(' ')}`, 'runner');

  return new Promise((resolve, reject) => {
    const normalizedCmd = cmd.startsWith('~/') ? cmd.replace('~', process.env.HOME ?? '') : cmd;
    const logFileStream = createLogStream(logFilePath);

    const child = spawn(normalizedCmd, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    const stdoutState = { content: '', buffer: '' };
    const stderrState = { content: '', buffer: '' };

    child.stdout.on('data', (data: Buffer) => {
      handleStreamData(data, stdoutState, {
        logStream: logFileStream,
        silentStdout,
        onProgress,
        isStderr: false,
      });
    });

    child.stderr.on('data', (data: Buffer) => {
      handleStreamData(data, stderrState, {
        logStream: logFileStream,
        silentStdout,
        onProgress,
        isStderr: true,
      });
    });

    child.on('close', (code) => {
      if (logFileStream) {
        logFileStream.end();
      }
      logger.info(`CLI process exited with code ${code}`, 'runner');
      resolve({ stdout: stdoutState.content, stderr: stderrState.content, code });
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

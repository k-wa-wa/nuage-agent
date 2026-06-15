import { exec, spawn } from 'child_process';
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
 * Runs a command in a child process and returns the results.
 */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { cmd, args, cwd, env } = options;

  logger.debug(`Executing: ${cmd} ${args.join(' ')} in Cwd: ${cwd}`, 'runner');

  return new Promise((resolve, reject) => {
    // We expand home directory (~) if present in the command path
    const normalizedCmd = cmd.startsWith('~/')
      ? cmd.replace('~', process.env.HOME || '')
      : cmd;

    const child = spawn(normalizedCmd, args, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      logger.debug(chunk.trim(), 'runner:stdout');
    });

    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      logger.debug(chunk.trim(), 'runner:stderr');
    });

    child.on('close', (code) => {
      logger.debug(`Process exited with code ${code}`, 'runner');
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      logger.error(`Process error: ${err.message}`, 'runner');
      reject(err);
    });
  });
}

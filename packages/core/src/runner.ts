import { spawn } from 'child_process';
import { logger } from './logger.js';

export interface RunCommandOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
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
  const { cmd, args, cwd, env, stdin } = options;

  logger.info(`Executing CLI: ${cmd} ${args.join(' ')}`, 'runner');

  return new Promise((resolve, reject) => {
    // We expand home directory (~) if present in the command path
    const normalizedCmd = cmd.startsWith('~/')
      ? cmd.replace('~', process.env.HOME || '')
      : cmd;

    const child = spawn(normalizedCmd, args, {
      cwd,
      shell: false, // Turn off shell to prevent DEP0190 and escaping issues
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';

    // Write prompt to stdin if provided
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Output CLI progress in real-time
      process.stdout.write(chunk);
    });

    child.stderr?.on('data', (data) => {
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


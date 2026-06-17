import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, type RunCommandResult } from './runner.js';

export interface AIAgentRunner {
  readonly id: string;
  run(options: {
    prompt: string;
    cwd: string;
    logFilePath?: string;
    flags?: string[];
    onProgress?: (line: string) => void;
    stdio?: 'inherit' | 'pipe';
  }): Promise<RunCommandResult>;
}

/**
 * @what Claude Code CLI を起動・実行するための Runner 実装クラス。
 * @why Claude CLI コマンドのパス解決と、標準的な引数構築ルールをカプセル化するため。
 */
export class ClaudeRunner implements AIAgentRunner {
  readonly id = 'claude';
  static readonly candidates = ['claude', '~/.local/bin/claude'];
  private readonly commandPath: string;

  constructor() {
    this.commandPath = resolveCommandPath(ClaudeRunner.candidates);
  }

  /**
   * @what 指示プロンプトを引数として Claude CLI を実行し、結果を返します。
   * @why 指定のディレクトリで子プロセスとして Claude を起動し、標準入出力を適切に処理するため。
   */
  async run(options: {
    prompt: string;
    cwd: string;
    logFilePath?: string;
    flags?: string[];
    onProgress?: (line: string) => void;
    stdio?: 'inherit' | 'pipe';
  }): Promise<RunCommandResult> {
    const flags = options.flags ?? ['--dangerously-skip-permissions'];
    const args = [...flags, '-p', options.prompt];
    return runCommand({
      cmd: this.commandPath,
      args,
      cwd: options.cwd,
      logFilePath: options.logFilePath,
      silentStdout: options.stdio === 'inherit' ? false : true,
      onProgress: options.onProgress,
      stdio: options.stdio,
    });
  }
}

/**
 * @what Antigravity/Agy CLI を起動・実行するための Runner 実装クラス。
 * @why Antigravity CLI コマンドのパス解決と、標準的な引数構築ルールをカプセル化するため。
 */
export class AntigravityRunner implements AIAgentRunner {
  readonly id = 'antigravity';
  static readonly candidates = [
    'agy',
    'antigravity',
    '~/.local/bin/agy',
    '~/.local/bin/antigravity',
  ];
  private readonly commandPath: string;

  constructor() {
    this.commandPath = resolveCommandPath(AntigravityRunner.candidates);
  }

  /**
   * @what 指示プロンプトを引数として Antigravity CLI を実行し、結果を返します。
   * @why 指定のディレクトリで子プロセスとして Antigravity を起動し、標準入出力を適切に処理するため。
   */
  async run(options: {
    prompt: string;
    cwd: string;
    logFilePath?: string;
    flags?: string[];
    onProgress?: (line: string) => void;
    stdio?: 'inherit' | 'pipe';
  }): Promise<RunCommandResult> {
    const flags = options.flags ?? ['--dangerously-skip-permissions'];
    const args = [...flags, '-p', options.prompt];
    return runCommand({
      cmd: this.commandPath,
      args,
      cwd: options.cwd,
      logFilePath: options.logFilePath,
      silentStdout: options.stdio === 'inherit' ? false : true,
      onProgress: options.onProgress,
      stdio: options.stdio,
    });
  }
}

/**
 * @what コマンドパスの優先候補リストから、実行環境で実際に利用可能なコマンドパスを解決します。
 * @why グローバルなPATH上のコマンドか、ローカルな ~/.local/bin 等のパスかを動的にフォールバック探索するため。
 */
export function resolveCommandPath(candidates: string[]): string {
  for (const candidate of candidates) {
    const expanded = candidate.startsWith('~/') ? candidate.replace('~', os.homedir()) : candidate;

    if (path.isAbsolute(expanded) || expanded.includes('/')) {
      if (fs.existsSync(expanded)) {
        return expanded;
      }
    } else {
      try {
        execSync(`command -v ${expanded}`, { stdio: 'ignore' });
        return expanded;
      } catch {
        // 次の候補へ
      }
    }
  }
  // 何も見つからなかった場合は最後の候補をフォールバックとして返す
  return candidates[candidates.length - 1] ?? '';
}

import { describe, expect, it } from 'bun:test';
import * as path from 'path';
import { resolveCommandPath, ClaudeRunner, AntigravityRunner } from './agent-runner.js';

describe('agent-runner', () => {
  describe('resolveCommandPath', () => {
    it('should resolve absolute path if it exists', () => {
      // 本体のテストファイル自体の絶対パスは存在するはず
      const existingFile = path.resolve(import.meta.dir, 'agent-runner.test.ts');
      const resolved = resolveCommandPath([existingFile]);
      expect(resolved).toBe(existingFile);
    });

    it('should resolve system command if it exists in PATH', () => {
      // 'ls' コマンドはLinux環境に存在するはず
      const resolved = resolveCommandPath(['ls']);
      expect(resolved).toBe('ls');
    });

    it('should fallback to subsequent candidate if first one does not exist', () => {
      const nonExistent = '/tmp/nonexistent-command-path-12345';
      const resolved = resolveCommandPath([nonExistent, 'ls']);
      expect(resolved).toBe('ls');
    });

    it('should return the last candidate if none of them exist', () => {
      const nonExistent1 = '/tmp/nonexistent-command-path-1';
      const nonExistent2 = '/tmp/nonexistent-command-path-2';
      const resolved = resolveCommandPath([nonExistent1, nonExistent2]);
      expect(resolved).toBe(nonExistent2);
    });
  });

  describe('Runners candidates', () => {
    it('ClaudeRunner should have candidate paths', () => {
      expect(ClaudeRunner.candidates).toContain('claude');
      expect(ClaudeRunner.candidates).toContain('~/.local/bin/claude');
    });

    it('AntigravityRunner should have candidate paths', () => {
      expect(AntigravityRunner.candidates).toContain('agy');
      expect(AntigravityRunner.candidates).toContain('antigravity');
    });
  });

  describe('Runners instantiation', () => {
    it('should instantiate ClaudeRunner without errors', () => {
      const runner = new ClaudeRunner();
      expect(runner.id).toBe('claude');
    });

    it('should instantiate AntigravityRunner without errors', () => {
      const runner = new AntigravityRunner();
      expect(runner.id).toBe('antigravity');
    });
  });
});

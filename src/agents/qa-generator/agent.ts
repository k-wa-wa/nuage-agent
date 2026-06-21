import { ClaudeRunner } from '../../core/index.js';
import type { Agent, AgentContext } from '../types.js';

/**
 * @what QA改善およびテスト・Lintの拡充用Issueを自動起票するプロアクティブエージェント（QAGeneratorAgent）です。
 * @why 開発自動化において、コードベースのテスト網羅率や品質を継続的に改善するため、
 *      リポジトリマップからテスト不足箇所やLint設定変更箇所を自動分析し、極力小さくマージしやすいタスクとしてIssueを起票します。
 */
export class QAGeneratorAgent implements Agent {
  readonly id = 'qa-generator';
  readonly targetType = 'issue';
  readonly label = ''; // Proactive agent, not reactive to any label
  readonly runner = new ClaudeRunner();
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /**
   * @what LLM CLI（Claude）に引き渡すプロアクティブ起票指示プロンプトを構築します。
   * @why リポジトリ構成、既存テスト、Lint定義などを自律分析させ、最も小さくマージが容易な改善点に絞ってIssueを起票させるため。
   */
  buildPrompt(context: AgentContext): string {
    const { repoName, repoMapMd } = context;

    return `あなたは対象リポジトリ「${repoName}」のQA改善・品質向上エージェント (QAGeneratorAgent) である。
以下のリポジトリ構成マップとコードベースの構成を参考に、テストやLintの拡充・改善案を1つだけ考えること。

${repoMapMd}

---

## 任務
リポジトリのソースコード、テスト構成（テストフレームワーク、テストファイル等）、あるいはLint設定を分析し、**極力小さく、すぐに実装・マージが可能なQA改善課題（例：特定の関数に対するテストケースの追加、エッジケースの検証、不足している型アサーションやLintルールの有効化）**を1つだけ見つけ出すこと。

見つかった改善点について、GitHub上に新しいIssueを起票すること。

## 起票に関するルール
1. **既存Issueの重複チェック**:
   既に同じ内容、あるいは類似するQA改善Issueが立っていないか、適宜確認すること。
2. **Issueタイトル**:
   必ず \`${this.prefix} \` というプレフィックスをタイトルに付けること。
   例: \`${this.prefix} math.ts の sum 関数に対するマイナス値のテストケース追加\`
3. **Issue本文**:
   タイトルだけでなく、課題の背景、具体的な実装箇所のファイルパス、および期待されるテスト/改善コードの満たすべき要件（Acceptance Criteria）をMarkdownで記述すること。
4. **ラベルの付与**:
   新しく作成するIssueには、必ず \`agent:spec\` ラベルを付与すること。
   これにより、以降の開発パイプライン（仕様定義 -> 実装 -> レビュー -> QA -> マージ）が自動的に起動します。

## 実行するコマンドの例
「gh issue create --repo "${repoName}" --title "${this.prefix} <具体的な改善内容>" --body "<Issueの詳細説明...>" --label "agent:spec"」
`;
  }
}

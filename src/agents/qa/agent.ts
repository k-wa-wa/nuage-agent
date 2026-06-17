import { ClaudeRunner } from '../../core/index.js';
import type { Agent, AgentContext } from '../types.js';

/**
 * @what マージ前の最終検証を行うQAエージェント（QAAgent）としての指示プロンプトを構築します。
 * @why 対象PRブランチをローカルに取得して統合・E2Eテストを実行し、テスト通過時にマージとブランチ削除を行い、失敗時には開発へ差し戻すフローを指示するため。
 */
export class QAAgent implements Agent {
  readonly id = 'qa';
  readonly targetType = 'pr';
  readonly label = 'agent:qa';
  readonly runner = new ClaudeRunner();

  /**
   * @what QAエージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）に、PRのチェックアウト、検証テスト実行、テスト成功/失敗時の挙動を正しく指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName } = context;

    if (!pr) {
      throw new Error('QAAgent requires a pull request in context');
    }

    const successBranchAction = context.autoMerge
      ? `実行したテスト内容、ビルド結果、監査レポートなどの「検証サマリ」を作成し、PRコメントとして投稿した後に、PRをマージしてブランチを削除する。
     コマンド:
       - サマリコメント投稿: 「gh pr comment ${pr.number} --body "[QA検証サマリ...]\n\n検証に合格したため、自動マージを実行します。"」
       - PRマージとブランチ削除: 「gh pr merge ${pr.number} --merge --delete-branch」`
      : `実行したテスト内容、ビルド結果、監査レポートなどの「検証サマリ」を作成し、PRコメントとして投稿してユーザーにマージを委ねる。その後、QAラベルを剥がす。
     コマンド:
       - サマリコメント投稿: 「gh pr comment ${pr.number} --body "[QA検証サマリ...]\n\n検証に合格したため、手動でのマージを求める。"」
       - ラベルの剥がし: 「gh issue edit ${pr.number} --remove-label "agent:qa"」`;

    return `あなたは対象リポジトリ「${repoName}」のQAエージェント (QAAgent) である。
GitHub Pull Request #${pr.number} の最終検証を行い、以下の手順を実行すること。

単体テスト等の個別検証はすでに開発（Dev）段階で完了している。ここでは、マージ直前のシステム全体としての品質と安全性を検証すること。

---

## 効率的な行動原則（重要）
- **重複調査の禁止**: \`gh pr view\` などの確認・調査コマンドを何度も繰り返し実行しないこと。
- **無駄な試行の抑制**: 検証コマンド（テスト、脆弱性スキャンなど）やラベル変更・マージ処理が失敗した場合は、エラーログを注意深く読み、原因に応じた適切な対処を行うこと。
- **セッション制限の意識**: APIセッション制限を回避するため、不要なコマンド実行やファイル探索を最小限に留め、速やかに検証を完了させること。

---

## 検証項目
1. **最新状態の統合確認**:
   作業ブランチにマージ先（mainやmaster）の最新コミットを取り込み、競合がなく正常にビルドできるかを確認する。
2. **結合・E2Eテスト**:
   統合テストやE2Eテスト、システム全体に関わる動作確認を実行する（例: 「npm run test:integration」など）。
3. **セキュリティ監査**:
   脆弱性スキャン（例: 「npm audit」など）を実行し、セキュリティ上の問題を持つ依存関係が新規追加されていないか確認する。

## アクション手順

1. **ブランチのチェックアウト**
   対象のPRブランチをローカルにチェックアウトする。
   コマンド: 「gh pr checkout ${pr.number}」

2. **検証の実行**
   上記の「検証項目」を実行する。

3. **検証結果の処理**
   - **検証に合格した場合（Passed）**:
     ${successBranchAction}
   - **検証に合格しなかった場合（Failed）**:
     失敗したテスト、競合内容、または検出された脆弱性などの不合格理由をPRコメントとして投稿し、ラベルを開発フェーズに戻す。
     コマンド:
       - 不合格コメント投稿: 「gh pr comment ${pr.number} --body "[検証失敗の詳細と原因]"」
       - ラベル変更: 「gh issue edit ${pr.number} --add-label "agent:dev" --remove-label "agent:qa"」
`;
  }
}

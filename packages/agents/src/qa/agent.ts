import type { Agent, AgentContext } from '../types.js';

/**
 * @what マージ前の最終検証を行うQAエージェント（QAAgent）としての指示プロンプトを構築します。
 * @why 対象PRブランチをローカルに取得して統合・E2Eテストを実行し、テスト通過時にマージとブランチ削除を行い、失敗時には開発へ差し戻すフローを指示するため。
 */
export class QAAgent implements Agent {
  readonly id = 'qa';
  readonly targetType = 'pr';
  readonly label = 'agent:qa';
  readonly commandType = 'claude';

  /**
   * @what QAエージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）に、PRのチェックアウト、検証テスト実行、テスト成功時のマージ、失敗時の開発者差し戻し処理を正しく指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName } = context;

    if (!pr) {
      throw new Error('QAAgent requires a pull request in context');
    }

    return `あなたは対象リポジトリ「${repoName}」のQAエージェント (QAAgent) である。
GitHub Pull Request #${pr.number} の検証を行い、以下の手順を実行すること。

## アクション手順

1. **ブランチのチェックアウト**
   対象のPRブランチをローカルにチェックアウトする。
   コマンド: 「gh pr checkout ${pr.number}」

2. **検証テストの実行**
   ローカル環境で統合テスト、E2Eテスト、システム動作確認を実行する（例: 「npm run test:integration」など）。

3. **検証結果の処理**
   - **合格した場合**:
     PRをマージし、作業ブランチを削除する。
     コマンド: 「gh pr merge ${pr.number} --merge --delete-branch」
   - **合格しなかった場合**:
     PRに不合格理由をコメントし、ラベルを開発フェーズに戻す。
     コマンド:
       - コメント投稿: 「gh pr comment ${pr.number} --body "[テスト失敗の内容と原因]"」
       - ラベル変更: 「gh pr edit ${pr.number} --add-label "agent:dev" --remove-label "agent:qa"」
`;
  }
}

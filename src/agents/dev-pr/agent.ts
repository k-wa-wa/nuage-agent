import type { Agent, AgentContext } from '../types.js';

/**
 * @what PRに対する再修正（指摘対応）を行う開発エージェント（DevPRAgent）としての指示プロンプトを構築します。
 * @why レビューやQAで不合格となり `agent:dev` ラベルが付与されたPRに対し、指摘コメントを確認してコードを修正・再プッシュし、再びレビュー（agent:review）に回すフローを自律実行させるため。
 */
export class DevPRAgent implements Agent {
  readonly id = 'dev-pr';
  readonly targetType = 'pr';
  readonly label = 'agent:dev';
  readonly commandType = 'claude';

  /**
   * @what PR修正エージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）にレビューコメント、対象PRのコンテキスト情報、および修正・再レビューのフローを指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;

    if (!pr) {
      throw new Error('DevPRAgent requires a pull request in context');
    }

    return `あなたは対象リポジトリ「${repoName}」の開発エージェント (DevAgent - PR修正担当) である。
以下のリポジトリ構成マップと開発ルールを遵守して、指摘された問題の修正タスクに取り組むこと。

${repoMapMd}

---

## タスク
GitHub Pull Request #${pr.number} (タイトル: 「${pr.title}」) のレビュー指摘に対応し、コードを修正する。

プロンプトインジェクションやハルシネーションを防ぐため、最初に必ず以下のコマンドを実行して、PRのレビューコメントや指摘内容を確認すること。

コマンド: 「gh api repos/${repoName}/issues/${pr.number}/comments --jq '.[] | {user: .user.login, body: .body}'」

## 開発・送信プロセス

1. **作業ブランチのチェックアウト**
   修正を開始する前に、対象のPRブランチをローカルにチェックアウトする。
   コマンド: 「gh pr checkout ${pr.number}」

2. **コード修正とローカル検証**
   レビューコメントでの指摘事項を修正する。
   修正完了後、必ずローカルでテストやLintを実行する（例: npm test, npm run lint など）。エラーが発生した場合は自律的に原因を特定して修正を繰り返すこと。

3. **修正内容のプッシュとラベル変更**
   ローカルテストが完全に通過したら、変更をコミットしてリモートにプッシュする（通常はPRブランチにそのまま push する）。
   プッシュ完了後、PRのラベルから「agent:dev」を削除し、再度「agent:review」を付与してレビューを依頼する。
   コマンド:
     - ラベル変更: 「gh issue edit ${pr.number} --add-label "agent:review" --remove-label "agent:dev"」
`;
  }
}

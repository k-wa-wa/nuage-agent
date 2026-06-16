import type { Agent, AgentContext } from '../types.js';

/**
 * @what 開発フェーズのエージェント（DevAgent）としての指示プロンプトを構築します。
 * @why 確定した仕様（Issue本文）に基づき、ローカルブランチ作成、ファイルの実装、コンパイル・テスト確認、そして GitHub 上にPRを作成（レビュー依頼）する一連の自律開発フローを指示するため。
 */
export class DevAgent implements Agent {
  readonly id = 'dev';
  readonly label = 'agent:dev';
  readonly commandType = 'claude';

  /**
   * @what 開発フェーズのエージェント（DevAgent）を初期化します。
   * @why 通常開発（Issue起票）と、PRへの指摘対応（PR）で共通の修正ロジックと動作を対象とするため。
   */
  constructor(readonly targetType: 'issue' | 'pr' = 'issue') {}

  /**
   * @what 開発エージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）にリポジトリ構造情報、IssueまたはPRの文脈、および自律的開発ステップ（実装、テスト、PR作成またはプッシュ等）を適切に指示するため。
   */
  buildPrompt(context: AgentContext): string {
    if (this.targetType === 'issue') {
      return this.buildIssuePrompt(context);
    } else {
      return this.buildPRPrompt(context);
    }
  }

  /**
   * @what Issueベースの開発用指示プロンプト文を組み立てます。
   * @why 開発エージェントに対して、新規の仕様に沿った実装、テスト、PR作成手順を指示するため。
   */
  private buildIssuePrompt(context: AgentContext): string {
    const { issue, repoName, repoMapMd } = context;
    if (!issue) {
      throw new Error('DevAgent requires an issue in context when targetType is issue');
    }

    return `あなたは対象リポジトリ「${repoName}」の開発エージェント (DevAgent) である。
以下のリポジトリ構成マップと開発ルールを遵守してタスクに取り組むこと。

${repoMapMd}

---

## タスク
GitHub Issue #${issue.number} (タイトル: 「${issue.title}」) に記載された仕様に基づいてコードを実装する。
最初に必ず以下のコマンドを実行して Issue の本文から確定した仕様（PRD / 受け入れ基準）を取得し、確認すること。

コマンド: 「gh issue view ${issue.number}」

## 開発・送信プロセス

1. **作業ブランチの作成**
   実装を開始する前に、最新の main/master ブランチから「feature/issue-${issue.number}」という新しい作業ブランチを作成する。
   コマンド: 「git checkout -b feature/issue-${issue.number}」

2. **コード実装とローカル検証**
   仕様を満たすようにコードを実装・修正する。
   修正完了後、必ずローカルでテストやLintを実行する（例: npm test, npm run lint など）。エラーが発生した場合は自律的に原因を特定して修正を繰り返すこと。

3. **Pull Requestの作成とラベル変更**
   ローカルテストが完全に通過したら、変更をリモートにプッシュし、Pull Request (PR) を作成する。
   - PRのタイトル: 「feat: #${issue.number} ${issue.title}」
   - PRのラベル: 「agent:review」を付与する。
     コマンド: 「gh pr create --title "feat: #${issue.number} ${issue.title}" --body "Closes #${issue.number}" --label "agent:review"」
   - PR作成後、元のIssueのラベルから「agent:dev」を剥がす。
     コマンド: 「gh issue edit ${issue.number} --remove-label "agent:dev"」
`;
  }

  /**
   * @what PR指摘対応用の指示プロンプト文を組み立てます。
   * @why 開発エージェントに対して、PRのレビュー指摘コメントを確認・修正し、再プッシュする手順を指示するため。
   */
  private buildPRPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;
    if (!pr) {
      throw new Error('DevAgent requires a pull request in context when targetType is pr');
    }

    return `あなたは対象リポジトリ「${repoName}」の開発エージェント (DevAgent - PR修正担当) である。
以下のリポジトリ構成マップと開発ルールを遵守して、指摘された問題の修正タスクに取り組むこと。

${repoMapMd}

---

## タスク
GitHub Pull Request #${pr.number} (タイトル: 「${pr.title}」) のレビュー指摘に対応し、コードを修正する。

最初に必ず以下のコマンドを実行して、PRのレビューコメントや指摘内容を確認すること。

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

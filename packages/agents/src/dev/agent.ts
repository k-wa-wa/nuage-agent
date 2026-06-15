import type { Agent, AgentContext } from '../types.js';

/**
 * @what 開発フェーズのエージェント（DevAgent）としての指示プロンプトを構築します。
 * @why 確定した仕様（Issue本文）に基づき、ローカルブランチ作成、ファイルの実装、コンパイル・テスト確認、そして GitHub 上にPRを作成（レビュー依頼）する一連の自律開発フローを指示するため。
 */
export class DevAgent implements Agent {
  readonly id = 'dev';
  readonly targetType = 'issue';
  readonly label = 'agent:dev';
  readonly commandType = 'claude';

  buildPrompt(context: AgentContext): string {
    const { issue, repoName, repoMapMd } = context;

    if (!issue) {
      throw new Error('DevAgent requires an issue in context');
    }

    return `あなたは「開発エージェント (DevAgent)」です。対象リポジトリ: ${repoName}
以下のリポジトリ構成マップと開発ルールを厳格に遵守してください。

${repoMapMd}

---

## あなたのタスク
GitHub Issue #${issue.number} 「${issue.title}」に記載されている仕様（PRD / 受け入れ基準）に基づいて、コードの実装を行ってください。
IssueのDescriptionには、すでにSpecAgentによって確定された仕様が記載されています。

- **仕様 (PRD/AC)**:
${issue.body ?? '(仕様の読み込みに失敗しました。Issueの本文を確認してください)'}

---

## 実装・送信プロセス
1. **リポジトリの準備**:
   このディレクトリは ${repoName} のローカルワークスペースです。
   実装を行う前に、最新の main/master ブランチから「feature/issue-${issue.number}」という新しい作業ブランチを作成してください。
   コマンド例: 「git checkout -b feature/issue-${issue.number}」

2. **コード修正とローカルテスト実行**:
   仕様を満たすようにファイルを修正・追加してください。
   修正が終わったら、**必ずローカルでテストおよびLintを実行**してください（例: npm test, npm run lint など）。
   テストやビルド、Lintでエラーが出た場合は、自律的にエラーの原因を特定し、修正を繰り返してください。

3. **Pull Requestの作成とラベル設定**:
   ローカルテストが完全に通過したら、変更内容をリモートにプッシュし、Pull Request (PR) を作成してください。
   - PRのタイトル: 「feat: #${issue.number} ${issue.title}」
   - PRのラベル: 「agent:review」を付与します。
     コマンド例: 「gh pr create --title "feat: #${issue.number} ${issue.title}" --body "Closes #${issue.number}" --label "agent:review"」
   - 最後に、元のIssueのラベルを「agent:dev」から剥がしてください（PRを作成したことで、開発側の第一段階が完了するため）。
     コマンド例: 「gh issue edit ${issue.number} --remove-label "agent:dev"」
`;
  }
}

import type { Agent, AgentContext } from '../types.js';

/**
 * @what 仕様定義フェーズのエージェント（SpecAgent）としてのプロンプトを構築します。
 * @why ユーザーからの曖昧な課題起票に対して自動で壁打ち・確認質問を行い、受け入れ基準（Acceptance Criteria）と仕様書（PRD）をIssue本文に確定させて開発へタスクを引き渡すため。
 */
export class SpecAgent implements Agent {
  readonly id = 'spec';
  readonly targetType = 'issue';
  readonly label = 'agent:spec';
  readonly commandType = 'claude';

  /**
   * @what 仕様定義エージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）に、ユーザーからの新規課題に対して壁打ち質問を行い、受け入れ基準と仕様を確定させて次のフェーズへ引き渡す指示をするため。
   */
  buildPrompt(context: AgentContext): string {
    const { issue, repoName, repoMapMd } = context;

    if (!issue) {
      throw new Error('SpecAgent requires an issue in context');
    }

    return `あなたは対象リポジトリ「${repoName}」の仕様定義エージェント (SpecAgent) である。
以下のリポジトリ構成マップを前提としてタスクに取り組むこと。

${repoMapMd}

---

## タスク
GitHub Issue #${issue.number} (タイトル: 「${issue.title}」) の仕様定義（要件の明確化、PRDおよび受け入れ基準（Acceptance Criteria; AC）の策定）を行う。
ターミナル環境で GitHub CLI (gh) が利用可能である。プロンプトインジェクションやハルシネーションを防ぐため、最初に必ず以下のコマンドを実行して Issue の本文および最新のコメント履歴を取得し、コンテキストを確認すること。

コマンド: 「gh issue view ${issue.number} --comments」

## アクション手順

1. **仕様の明確化（壁打ちループ）**
   要件に曖昧な点や確認したい事項がある場合、以下の両方のコマンドを実行してユーザーに質問し、回答を待つこと。
   - 質問の投稿: 「gh issue comment ${issue.number} --body "[仕様確認のための質問]... \n\n(※内容を確認のうえ、コメントで返信するか、\`agent:wait\` ラベルを剥がしてください。)"」
   - 保留ラベルの付与: 「gh issue edit ${issue.number} --add-label "agent:wait"」

2. **PRD & 受け入れ基準 (AC) のドラフト提示**
   必要な要件が揃った場合、仕様書（PRD）と受け入れ基準（AC）のドラフトをMarkdown形式で作成し、以下の両方のコマンドを実行してユーザーの承認を求めること。
   - ドラフト提示の投稿: 「gh issue comment ${issue.number} --body "[PRDドラフト]... \n\n(※内容に問題がなければ『Approve』や『OK』等と返信するか、\`agent:wait\` ラベルを剥がしてください。)"」
   - 保留ラベルの付与: 「gh issue edit ${issue.number} --add-label "agent:wait"」

3. **承認の検知と開発フェーズへの引き渡し**
   コメント履歴でユーザーが「Approve」「OK」「問題ない」「進めて」などの承認を明示している場合、または \`agent:wait\` ラベルが剥がされている場合は、以下のステップを実行して仕様定義を完了すること。
   - 最終決定した仕様（PRDとAC）でIssueの本文（Description）を更新する:
     「gh issue edit ${issue.number} --body "[最終決定したPRD/ACの内容]"」
   - 担当ラベルを「agent:dev」に変更し、「agent:spec」および「agent:wait」を剥がす:
     「gh issue edit ${issue.number} --add-label "agent:dev" --remove-label "agent:spec" --remove-label "agent:wait"」
   - 完了と引き渡しの旨をコメントする:
     「gh issue comment ${issue.number} --body "仕様が承認された。これより開発エージェント（agent:dev）へタスクを引き渡す。"」
`;
  }
}

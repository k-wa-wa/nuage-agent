import { Agent, AgentContext } from '../types.js';

/**
 * @what 仕様定義フェーズのエージェント（SpecAgent）としてのプロンプトを構築します。
 * @why ユーザーからの曖昧な課題起票に対して自動で壁打ち・確認質問を行い、受け入れ基準（Acceptance Criteria）と仕様書（PRD）をIssue本文に確定させて開発へタスクを引き渡すため。
 */
export class SpecAgent implements Agent {
  readonly id = 'spec';
  readonly targetType = 'issue';
  readonly label = 'agent:spec';
  readonly commandType = 'claude';

  buildPrompt(context: AgentContext): string {
    const { issue, commentsMarkdown, repoName, repoMapMd } = context;

    if (!issue) {
      throw new Error('SpecAgent requires an issue in context');
    }

    return `あなたは「仕様定義エージェント (SpecAgent)」です。対象リポジトリ: ${repoName}
以下のリポジトリ構成マップとガイドラインを頭に入れて課題に取り組んでください。

${repoMapMd}

---

## あなたのタスク
GitHub Issue #${issue.number} 「${issue.title}」の仕様定義（壁打ち・PRD作成・受け入れ基準策定）を行ってください。
GitHub CLIコマンド「gh」があなたのターミナル環境で利用可能です。必要に応じて「gh issue view ${issue.number}」や「gh issue comment」を利用して情報を取得・投稿してください。

## 会話履歴とIssue内容
- **Issue本文**:
${issue.body || '(本文なし)'}

- **最近のコメント履歴**:
${commentsMarkdown || '(コメントなし)'}

---

## 振る舞いのルール
1. **仕様の明確化（壁打ちループ）**:
   まだ要件が曖昧であったり、追加で確認したい事項がある場合は、以下の両方のコマンドを実行してユーザーに質問を投げ、回答を待ってください：
   - 質問コメント: 「gh issue comment ${issue.number} --body \"[仕様確認のための質問]... \n\n(※内容を確認のうえ、コメントをご返信いただくか、または \`agent:wait\` ラベルを剥がしてください。)\"」
   - 保留ラベル付与: 「gh issue edit ${issue.number} --add-label \"agent:wait\"」

2. **PRD & 受け入れ基準 (AC) のドラフト提示**:
   必要な要件が揃ったら、仕様書（PRD）と受け入れ基準（Acceptance Criteria）のドラフトをMarkdown形式で作成し、以下の両方のコマンドを実行してユーザーに承認を求めてください：
   - ドラフト提示コメント: 「gh issue comment ${issue.number} --body \"[PRDドラフト]... \n\n(※内容に問題がなければ『Approve』や『OK』とご返信いただくか、または \`agent:wait\` ラベルを剥がしてください。)\"」
   - 保留ラベル付与: 「gh issue edit ${issue.number} --add-label \"agent:wait\"」

3. **承認の検知と引き渡し**:
   コメント履歴の中で、ユーザーが「Approve」「OK」「問題ない」「進めて」などの承認を明示している場合、または \`agent:wait\` ラベルが剥がされている場合は、以下のステップを実行して仕様定義フェーズを完了させてください。
   - 最終的な仕様（PRDとAC）を、Issueの本文（Description）に上書き更新します。「gh issue edit ${issue.number} --body \"[最終決定したPRD/ACの内容]\"」
   - Issueの担当ラベルを「agent:dev」に変更し、「agent:spec」および「agent:wait」を剥がします。
     コマンド: 「gh issue edit ${issue.number} --add-label \"agent:dev\" --remove-label \"agent:spec\" --remove-label \"agent:wait\"」
   - 完了した旨をコメントします。
     コマンド: 「gh issue comment ${issue.number} --body \"仕様が承認されました。これより開発エージェント（agent:dev）へタスクを引き渡します。\"」
`;
  }
}

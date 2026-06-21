import { ClaudeRunner } from '../../core/index.js';
import type { Agent, AgentContext } from '../types.js';

const SPEC_PRINCIPLES = `## 効率的な行動原則（重要）
- **重複調査の禁止**: 「gh issue view」などの確認コマンドは必要最小限に留め、何度も繰り返し実行しないこと。
- **無駄な試行の抑制**: 予期しないエラーに直面した場合は、同じコマンドをそのまま再実行するのではなく、出力を観察して原因を特定したうえで対処すること。
- **セッション制限の意識**: APIセッション制限に達するのを防ぐため、最小限のコマンド実行回数でスマートにタスクを完了すること。`;

/**
 * @what 仕様定義フェーズのエージェント（SpecAgent）としてのプロンプトを構築します。
 * @why ユーザーからの曖昧な課題起票に対して自動で壁打ち・確認質問を行い、受け入れ基準（Acceptance Criteria）と仕様書（PRD）をIssue本文に確定させて開発へタスクを引き渡すため。
 */
export class SpecAgent implements Agent {
  readonly id = 'spec';
  readonly targetType = 'issue';
  readonly label = 'agent:spec';
  readonly runner = new ClaudeRunner();

  /**
   * @what 仕様定義エージェントのアクション手順プロンプトを生成します。
   * @why buildPromptの行数制限（max-lines-per-function）を回避し、かつ関数のエクスポートに際してJSDoc要件（@what/@why）を満たすため。
   */
  private getActionSteps(issueNumber: number): string {
    return `## アクション手順

1. **仕様の明確化（壁打ちループ）**
   要件に曖昧な点や確認したい事項がある場合、以下の両方のコマンドを実行してユーザーに質問し、回答を待つこと。
   - 質問の投稿: 「gh issue comment ${issueNumber} --body "[仕様確認のための質問]... \n\n(※内容を確認のうえ、コメントで返信するか、\`agent:wait\` ラベルを剥がすこと。)"」
   - 保留ラベルの付与: 「gh issue edit ${issueNumber} --add-label "agent:wait"」

2. **PRD & 受け入れ基準 (AC) のドラフト提示**
   必要な要件が揃った場合、仕様書（PRD）と受け入れ基準（AC）のドラフトをMarkdown形式で作成し、以下の両方のコマンドを実行してユーザーの承認を求めること。
   **【重要】受け入れ基準（AC）には、実装完了を客観的に検証するための「完了基準チェックリスト」を必ず \`- [ ]\` 形式（GitHub Markdown）で含めること。**
   - ドラフト提示の投稿: 「gh issue comment ${issueNumber} --body "[PRDドラフト]... \n\n(※内容に問題がなければ『Approve』や『OK』等と返信するか、\`agent:wait\` ラベルを剥がすこと。)"」
   - 保留ラベルの付与: 「gh issue edit ${issueNumber} --add-label "agent:wait"」

3. **承認の検知と開発フェーズへの引き渡し**
   ユーザーから「Approve」「OK」などの承認が得られた場合、または \`agent:wait\` ラベルが剥がされている場合は、タスクの規模を評価し、以下のいずれかの対応を実行すること。

   ### パターンA: 通常規模のタスク（分割が不要な場合）
   仕様定義フェーズを完了させ、開発エージェントへ引き渡す。
   - 最終決定した仕様（PRDとAC）で親Issueの本文（Description）を更新する。この際、**必ず本文内に \`- [ ]\` 形式の完了基準チェックリストが含まれていることを保証すること**。また、長文によるシェルエスケープのエラーを防ぐため、必ず一時ファイルを用いて更新すること。
     「echo "[最終決定したPRDおよび - [ ] 形式の完了基準チェックリストの内容]" > issue_body.md && gh issue edit ${issueNumber} --body-file issue_body.md && rm issue_body.md」
   - 担当ラベルを「agent:dev」に変更し、「agent:spec」および「agent:wait」を剥がす:
     「gh issue edit ${issueNumber} --add-label "agent:dev" --remove-label "agent:spec" --remove-label "agent:wait"」
   - 完了コメントを投稿する:
     「gh issue comment ${issueNumber} --body "仕様が承認された。これより開発エージェント（agent:dev）へタスクを引き渡す。"」

   ### パターンB: 大規模なタスク（分割が必要な場合）
   スコープが広く、複数の独立した機能追加や大きなリファクタリングを含むため、1回の開発サイクル（1つのPR）で実装するのが難しいと判断した場合は、タスクを分割して起票する。
   - 親Issueの本文を、全体のPRDと「分割されたサブIssueのチェックリスト」で更新する:
     「gh issue edit ${issueNumber} --body "[全体仕様PRD]\n\n## サブタスク一覧\n- [ ] [Sub-Task] <子タスク1のタイトル>\n- [ ] [Sub-Task] <子タスク2のタイトル>"」
   - 分割した各サブタスクについて、個別に新しい子Issueを起票する。この際、**子Issueの概要欄（Body）にも必ず \`- [ ]\` 形式の具体的な完了基準チェックリストを記載すること**。
     コマンド: 「gh issue create --title "[Sub-Task] <子タスクタイトル>" --body "親Issue: #${issueNumber}\n\n<具体的な仕様および - [ ] 形式の完了基準チェックリスト>" --label "agent:spec"」
     (※仕様がすでに明確な場合は、\`agent:spec\`の代わりに最初から\`agent:dev\`を付与してもよい)
   - 親Issueのステータスを「保留（agent:wait）」に変更し、子Issueの進行を待つ:
     「gh issue edit ${issueNumber} --add-label "agent:wait" --remove-label "agent:spec"」
   - 分割完了のコメントを投稿する:
     「gh issue comment ${issueNumber} --body "仕様が承認されたが、タスク規模が大きいためサブIssueに分割して起票した。サブタスクの完了を待つ。"」`;
  }

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

${SPEC_PRINCIPLES}

---

## タスク
GitHub Issue #${issue.number} (タイトル: 「${issue.title}」) の仕様定義（要件の明確化、PRDおよび受け入れ基準（Acceptance Criteria; AC）の策定）を行う。
ターミナル環境で GitHub CLI (gh) が利用可能である。最初に必ず以下のコマンドを実行して Issue の本文および最新のコメント履歴を取得し、コンテキストを確認すること。

コマンド: 「gh issue view ${issue.number} --comments」

${this.getActionSteps(issue.number)}
`;
  }
}

import { ClaudeRunner } from '../../core/index.js';
import type { Agent, AgentContext } from '../types.js';

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
ターミナル環境で GitHub CLI (gh) が利用可能である。最初に必ず以下のコマンドを実行して Issue の本文および最新のコメント履歴を取得し、コンテキストを確認すること。

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
   ユーザーから「Approve」「OK」などの承認が得られた場合、または \`agent:wait\` ラベルが剥がされている場合は、タスクの規模を評価し、以下のいずれかの対応を実行すること。

   ### パターンA: 通常規模のタスク（分割が不要な場合）
   仕様定義フェーズを完了させ、開発エージェントへ引き渡す。
   - 最終決定した仕様（PRDとAC）で親Issueの本文（Description）を更新する:
     「gh issue edit ${issue.number} --body "[最終決定したPRD/ACの内容]"」
   - 担当ラベルを「agent:dev」に変更し、「agent:spec」および「agent:wait」を剥がす:
     「gh issue edit ${issue.number} --add-label "agent:dev" --remove-label "agent:spec" --remove-label "agent:wait"」
   - 完了コメントを投稿する:
     「gh issue comment ${issue.number} --body "仕様が承認された。これより開発エージェント（agent:dev）へタスクを引き渡す。"」

   ### パターンB: 大規模なタスク（分割が必要な場合）
   スコープが広く、複数の独立した機能追加や大きなリファクタリングを含むため、1回の開発サイクル（1つのPR）で実装するのが難しいと判断した場合は、タスクを分割して起票する。
   - 親Issueの本文を、全体のPRDと「分割されたサブIssueのチェックリスト」で更新する:
     「gh issue edit ${issue.number} --body "[全体仕様PRD]\n\n## サブタスク一覧\n- [ ] [Sub-Task] <子タスク1のタイトル>\n- [ ] [Sub-Task] <子タスク2のタイトル>"」
   - 分割した各サブタスクについて、個別に新しい子Issueを起票する:
     コマンド: 「gh issue create --title "[Sub-Task] <子タスクタイトル>" --body "親Issue: #${issue.number}\n\n<具体的な仕様および受け入れ基準>" --label "agent:spec"」
     (※仕様がすでに明確な場合は、\`agent:spec\`の代わりに最初から\`agent:dev\`を付与してもよい)
   - 親Issueのステータスを「保留（agent:wait）」に変更し、子Issueの進行を待つ:
     「gh issue edit ${issue.number} --add-label "agent:wait" --remove-label "agent:spec"」
   - 分割完了のコメントを投稿する:
     「gh issue comment ${issue.number} --body "仕様が承認されたが、タスク規模が大きいためサブIssueに分割して起票した。サブタスクの完了を待つ。"」
`;
  }
}

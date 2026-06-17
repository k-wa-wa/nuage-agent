import { AntigravityRunner } from '../../core/index.js';
import type { Agent, AgentContext } from '../types.js';

/**
 * @what 一般レビューフェーズのエージェント（ReviewGeneralAgent）としての指示プロンプトを構築します。
 * @why 一般的なセキュリティ脆弱性やパフォーマンス問題（N+1問題など）を検知し、PRの合格・差し戻しを判定するレビュー観点を与えるため。
 */
export class ReviewGeneralAgent implements Agent {
  readonly id = 'review-general';
  readonly targetType = 'pr';
  readonly label = 'agent:review';
  readonly runner = new AntigravityRunner();

  /**
   * @what 一般レビューエージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Antigravity）にバグ、エラー、セキュリティやパフォーマンス観点でのPRレビューと合否判定を指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;

    if (!pr) {
      throw new Error('ReviewGeneralAgent requires a pull request in context');
    }

    return `あなたは対象リポジトリ「${repoName}」の一般コードレビューエージェント (General Reviewer) である。
以下のリポジトリ構成マップを基準としてレビューを行うこと。

${repoMapMd}

---

## タスク
GitHub Pull Request #${pr.number} (タイトル: 「${pr.title}」) の差分レビューを行う。
まず以下のコマンドを実行して差分を取得し、精査すること。

コマンド: 「gh pr diff ${pr.number}」

## レビュー観点
- **コード品質**: 一般的なバグ、シンタックスエラー、コーディングミスの有無。
- **パフォーマンス**: N+1クエリ問題や不要に重い処理の有無。
- **セキュリティ**: SQLインジェクション、コマンドインジェクション、ハードコードされた秘密情報などの脆弱性の有無。

## レビュー結果の処理ルール

1. **修正が必要な場合 (Failed)**
   指摘事項がある場合、PRにインラインまたは全体コメントで詳細な理由と修正案を投稿し、ラベルを開発フェーズに戻す。
   - コメント投稿: 「gh pr comment ${pr.number} --body "[指摘内容と修正案]"」
   - ラベル変更: 「gh issue edit ${pr.number} --add-label "agent:dev" --remove-label "agent:review"」

2. **問題ない場合 (Passed)**
   すべてのチェックに合格した場合、PRにApproveコメントを投稿する。
   - Approve投稿: 「gh pr review ${pr.number} --approve --body "[General Review Result: PASSED]\n一般レビューをパスした。"」
   (※他のレビューエージェントからもApproveが得られた時点で次のフェーズ（agent:qa）へ移行するため、ここではApproveを表明するだけでよい)
`;
  }
}

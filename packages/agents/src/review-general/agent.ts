import type { Agent, AgentContext } from '../types.js';

/**
 * @what 一般レビューフェーズのエージェント（ReviewGeneralAgent）としての指示プロンプトを構築します。
 * @why バグ、構文エラー、一般的なセキュリティ脆弱性やパフォーマンス問題（N+1問題など）を検知し、PRの合格・差し戻しを判定するレビュー観点を与えるため。
 */
export class ReviewGeneralAgent implements Agent {
  readonly id = 'review-general';
  readonly targetType = 'pr';
  readonly label = 'agent:review';
  readonly commandType = 'gemini';

  /**
   * @what 一般レビューエージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Gemini）にバグ、エラー、セキュリティやパフォーマンス観点でのPRレビューと合否判定を指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;

    if (!pr) {
      throw new Error('ReviewGeneralAgent requires a pull request in context');
    }

    return `あなたは「コードレビューエージェント - 一般レビューエージェント (General Reviewer)」です。対象リポジトリ: ${repoName}
以下のリポジトリ構成マップを基準としてレビューを行ってください。

${repoMapMd}

---

## あなたのタスク
GitHub Pull Request #${pr.number} 「${pr.title}」の差分レビューを行ってください。
GitHub CLI「gh」を使用して、「gh pr diff ${pr.number}」を実行し、差分を取得して精査してください。

---

## レビュー観点 (一般・品質)
- 一般的なバグ、シンタックスエラー、コーディングミスの有無。
- **パフォーマンス**: N+1クエリ問題がないか。不要に重い処理が追加されていないか。
- **セキュリティ**: SQLインジェクション、インセキュアなコマンドインジェクション、ハードコードされた秘密情報などの脆弱性がないか。
※なお、これらの項目は初期の検証例であり、具体的なチェックルールは今後のフェーズで詳細化していきます。

---

## レビュー結果の処理ルール
1. **修正が必要な場合 (Failed)**:
   - レビュー観点に抑触する箇所を見つけた場合、PRにインライン、または全体コメントとして詳細な理由と修正案を投稿してください。
     コマンド例: 「gh pr comment ${pr.number} --body "[指摘内容と修正のアドバイス]"」
   - ボールを開発者に返すため、PRのラベルから「agent:review」を剥がし、代わりに **「agent:dev」** を付与してください。
     コマンド例: 「gh pr edit ${pr.number} --add-label "agent:dev" --remove-label "agent:review"」

2. **問題ない場合 (Passed)**:
   - 全てのチェックが合格した場合、PRにApproveコメントを投稿してください。
     コマンド例: 「gh pr review ${pr.number} --approve --body "一般レビュー結果問題ありませんでした。パスします。"」
   - ※意味的・設計規約レビューエージェント（Claude）からも同様にApproveが得られた時点で、次の検証フェーズ（agent:qa）へ移行します。ここでは単純にApproveを表明して終了してください。
`;
  }
}

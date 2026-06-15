import type { Agent, AgentContext } from '../types.js';

/**
 * @what 設計規約・影響範囲チェックを行うレビューエージェント（ReviewSemanticAgent）としての指示プロンプトを構築します。
 * @why 対象プロジェクトの設計原則やディレクトリ構造ルール（repo-map）に適合しているか、ドキュメントが同期されているか、既存コードに破壊的な影響を及ぼさないかをチェックするため。
 */
export class ReviewSemanticAgent implements Agent {
  readonly id = 'review-semantic';
  readonly targetType = 'pr';
  readonly label = 'agent:review';
  readonly commandType = 'claude';

  buildPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;

    if (!pr) {
      throw new Error('ReviewSemanticAgent requires a pull request in context');
    }

    return `あなたは「コードレビューエージェント - 意味的・設計規約レビューエージェント (Semantic/Architectural Reviewer)」です。対象リポジトリ: ${repoName}
以下のリポジトリ構成マップを基準としてレビューを行ってください。

${repoMapMd}

---

## あなたのタスク
GitHub Pull Request #${pr.number} 「${pr.title}」の差分レビューを行ってください。
GitHub CLI「gh」を使用して、「gh pr diff ${pr.number}」を実行し、差分を取得して精査してください。

---

## レビュー観点 (セマンティック・設計)
- **設計規約適合度**: ${repoName} のフォルダレイアウトや設計原則、repo-mapで定義されたルールに沿っているか。
- **ドキュメントの同期**: APIの追加や重要な変更がある場合、関連するドキュメント（READMEやdocs/配下）も同時に更新されているか。
- **影響範囲（Blast Radius）**: 既存のコンポーネントに対する不必要な破壊的変更や副作用がないか。
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
     コマンド例: 「gh pr review ${pr.number} --approve --body "意味的レビュー結果問題ありませんでした。パスします。"」
   - ※一般レビューエージェント（Gemini）からも同様にApproveが得られた時点で、次の検証フェーズ（agent:qa）へ移行します。ここでは単純にApproveを表明して終了してください。
`;
  }
}

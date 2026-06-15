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

  /**
   * @what 意味的/設計規約レビューエージェント向けのシステム/ユーザー指示プロンプト文を組み立てます。
   * @why LLM（Claude）に設計ガイドラインやディレクトリ構造、ドキュメントの同期、破壊的変更チェックを含むPRレビューを指示するため。
   */
  buildPrompt(context: AgentContext): string {
    const { pr, repoName, repoMapMd } = context;

    if (!pr) {
      throw new Error('ReviewSemanticAgent requires a pull request in context');
    }

    return `あなたは対象リポジトリ「${repoName}」の意味的・設計規約レビューエージェント (Semantic/Architectural Reviewer) である。
以下のリポジトリ構成マップを基準としてレビューを行うこと。

${repoMapMd}

---

## タスク
GitHub Pull Request #${pr.number} (タイトル: 「${pr.title}」) の差分レビューを行う。
まず以下のコマンドを実行して差分を取得し、精査すること。

コマンド: 「gh pr diff ${pr.number}」

## レビュー観点
- **設計規約適合度**: ディレクトリ構造や設計原則、repo-mapで定義されたルールへの適合度。
- **ドキュメントの同期**: APIの追加や重要な変更に伴うREADME等のドキュメント更新の有無。
- **影響範囲**: 既存コンポーネントに対する不要な破壊的変更や副作用の有無。

## レビュー結果の処理ルール

1. **修正が必要な場合 (Failed)**
   指摘事項がある場合、PRにインラインまたは全体コメントで詳細な理由と修正案を投稿し、ラベルを開発フェーズに戻す。
   - コメント投稿: 「gh pr comment ${pr.number} --body "[指摘内容と修正案]"」
   - ラベル変更: 「gh pr edit ${pr.number} --add-label "agent:dev" --remove-label "agent:review"」

2. **問題ない場合 (Passed)**
   すべてのチェックに合格した場合、PRにApproveコメントを投稿する。
   - Approve投稿: 「gh pr review ${pr.number} --approve --body "[Semantic Review Result: PASSED]\n設計規約レビューをパスした。"」
   (※他のレビューエージェントからもApproveが得られた時点で次のフェーズ（agent:qa）へ移行するため、ここではApproveを表明するだけでよい)
`;
  }
}

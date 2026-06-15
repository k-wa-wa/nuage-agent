import { Agent, AgentContext } from '../types.js';

export class QAAgent implements Agent {
  readonly id = 'qa';
  readonly targetType = 'pr';
  readonly label = 'agent:qa';
  readonly commandType = 'claude';

  buildPrompt(context: AgentContext): string {
    const { pr, repoName } = context;

    if (!pr) {
      throw new Error('QAAgent requires a pull request in context');
    }

    return `あなたは「QAエージェント (QAAgent)」です。対象リポジトリ: ${repoName}
Pull Request #${pr.number} の検証を行ってください。
1. 作業ブランチをローカルにチェックアウトしてください。
2. 統合テストやE2Eテスト、システム動作確認を実行してください（例: npm run test:integration など）。
3. テストが完全にパスした場合、PRを自動マージしてクローズしてください。マージコマンド: 「gh pr merge ${pr.number} --merge --delete-branch」
4. テストに合格しなかった場合、PRのラベルから「agent:qa」を剥がし、理由を添えてコメントし、開発差し戻しのためにラベル **「agent:dev」** を付与してください。`;
  }
}

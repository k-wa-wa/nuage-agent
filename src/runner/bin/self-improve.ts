import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_WORKSPACES_DIR_NAME, ClaudeRunner } from '../../core/index.js';

const PROMPT_FILE_NAME = 'self_improvement_prompt.md';

/**
 * @what workspaces/[workspace]/logs/[task].log にマッチするすべてのログファイルパスを検索し、パスの配列として返す。
 * @why 自己改善フローの入力コンテキストとなる実行ログファイルを網羅的に収集するため。
 */
function findLogFiles(workspacesDir: string): string[] {
  const logFiles: string[] = [];
  if (!fs.existsSync(workspacesDir)) {
    return logFiles;
  }

  const workspaceFolders = fs.readdirSync(workspacesDir, { withFileTypes: true });
  for (const folder of workspaceFolders) {
    if (!folder.isDirectory()) {
      continue;
    }
    const logsDir = path.join(workspacesDir, folder.name, 'logs');
    if (!fs.existsSync(logsDir)) {
      continue;
    }
    const files = fs.readdirSync(logsDir);
    for (const file of files) {
      if (file.endsWith('.log')) {
        logFiles.push(path.join(logsDir, file));
      }
    }
  }

  return logFiles;
}

/**
 * @what Claude Code CLI に対する自己改善指示のプロンプトを Markdown 形式のテキストとして組み立てる。
 * @why 各ログファイルのパスと、Git操作禁止・改善範囲制限などの制約を含む指示内容を構造化してエージェントに伝えるため。
 */
function buildPromptContent(logFiles: string[]): string {
  const logListMd = logFiles
    .map((filePath) => {
      const relativePath = path.relative(process.cwd(), filePath);
      const absolutePath = path.resolve(filePath);
      return `- [ ] [${relativePath}](file://${absolutePath})`;
    })
    .join('\n');

  return `# エージェント自己改善タスク (Agent Self-Improvement Task)

あなたは \`nuage-agent\` の自己改善アシスタントである。
収集されたエージェントの実行結果ログ（エラー、非効率な挙動、プロンプトの不備など）を分析し、\`src/agents/\` 配下にある各エージェントのプロンプト定義や挙動ロジックを直接修正して改善せよ。

> [!IMPORTANT]
> **Git操作に関する禁止事項**
> - **コミット (\`git commit\`)、プッシュ (\`git push\`)、ブランチ変更・作成 (\`git checkout\`, \`git branch\`) などのGit操作は一切行わないこと。**
> - 今回の修正結果はGitの未コミットのまま残し、最終的なコミットやPR作成は人間（開発者）が行う。

> [!IMPORTANT]
> **改善の対象（スコープ）に関する注意事項**
> - **改善の対象は「このツール（nuage-agent / 各エージェントの定義）」の品質・挙動・プロンプトのみである。**
> - ログに記録されている個々の対象リポジトリのソースコードやバグを修正しないこと。対象リポジトリ側のソースコードの改善は本タスクの目的外である。
> - ログファイルに対する読み取り以外の操作は行わないこと。

## 分析対象のログファイル
以下のログファイルを順次、ファイル読み込みツール（\`read_file\` や bash の \`cat\` など）を使用して動的に読み込み、内容を分析せよ：

${logListMd}

## 修正対象のファイル
ログファイルの分析結果に基づき、以下のファイル内のプロンプト（\`buildPrompt\` メソッド内の指示など）やロジックを改善せよ：
- \`src/agents/spec/agent.ts\` (仕様定義エージェント: SpecAgent)
- \`src/agents/dev/agent.ts\` (開発エージェント: DevAgent)
- \`src/agents/review-general/agent.ts\` (一般レビューエージェント: ReviewGeneralAgent)
- \`src/agents/review-semantic/agent.ts\` (意味的レビューエージェント: ReviewSemanticAgent)
- \`src/agents/qa/agent.ts\` (QAエージェント: QAAgent)

## 改善のための分析観点
1. **エラーや失敗の回避**: テスト失敗や構文エラー、自己修復の無限ループ、API制限によるエラーなどが発生していないか。プロンプトに警告や前提条件を追加することでこれらを回避できないか検討する
2. **非効率な挙動の削減**: ループ回数の削減、APIコール回数の削減、より効率的なプロンプトの設計など、パフォーマンスを改善できないか検討する
3. **プロンプトの明確化**: 各エージェントの役割と責任を明確にし、誤解を招く表現や曖昧な指示を排除する

## 実行する手順
1. 上記の各ログファイルの内容を個別に読み込んで分析する。
2. 分析結果に基づき、対象エージェントのソースファイル（\`src/agents/**/*.ts\`）を直接修正してプロンプトや挙動を改善する。
`;
}

// resolveClaudeCommand has been removed in favor of resolveCommandPath(ClaudeRunner.candidates)

/**
 * @what 自己改善フローのエントリーポイントとして、ログ走査、指示ファイル生成、Claude CLI の実行および終了監視の一連の処理を実行する。
 * @why コマンドラインからスクリプトが起動された際に、指定されたステップに従って自己改善プロセスを完結させるため。
 */
async function main() {
  const rootDir = process.cwd();
  const workspacesDir = path.join(rootDir, DEFAULT_WORKSPACES_DIR_NAME);

  console.log('--- 自己改善フローを開始します ---');
  console.log(`ワークスペースディレクトリ: ${workspacesDir}`);

  // 1. ログファイルの走査
  const logFiles = findLogFiles(workspacesDir);
  if (logFiles.length === 0) {
    console.log('ログファイルが見つかりませんでした。処理を終了します。');
    return;
  }

  console.log(`${logFiles.length} 件のログファイルを検出しました。`);

  // 2. プロンプトファイルの作成
  const promptContent = buildPromptContent(logFiles);
  const promptFilePath = path.join(rootDir, PROMPT_FILE_NAME);
  fs.writeFileSync(promptFilePath, promptContent, 'utf-8');
  console.log(`指示ファイルを作成しました: ${promptFilePath}`);

  // 3. 引数の解析
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log('ドライランモードのため、Claude CLI の起動をスキップします。');
    console.log(
      `次のファイルを開いて、指示内容と対象ログ一覧を確認してください: ./${PROMPT_FILE_NAME}`,
    );
    return;
  }

  // 4. Claude CLIの起動
  console.log('Claude CLI を起動します...');

  const prompt = `Please read ${PROMPT_FILE_NAME}, perform the self-improvement task.`;
  console.log(`コマンド実行中: Claude CLI [prompt: ${prompt}]`);

  const runner = new ClaudeRunner();
  const result = await runner.run({
    prompt,
    cwd: rootDir,
    stdio: 'inherit',
  });

  console.log(`\nClaude CLI が終了コード ${result.code} で終了しました。`);
  if (result.code !== 0) {
    throw new Error(`Claude CLI exited with code ${result.code}`);
  }
}

main().catch((err: unknown) => {
  console.error('予期しないエラーが発生しました:', err);
  process.exit(1);
});

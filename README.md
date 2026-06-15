# nuage-agent

`nuage-agent` は、Claude Code や Gemini CLI などの自律型LLM CLIとGitHub Issue/PR駆動の、ステートレスかつ軽量な自動開発パイプラインである。

対象となるリポジトリ（`nuage-cluster`, `pechka` など）を定期的にクロールし、Issue/PRラベルとコメントをトリガーとして、仕様定義・開発・コードレビュー・QAの各エージェントを自動的にシェル経由で起動・実行する。

---

## 主な特徴

1. **完全ステートレス設計**
   状態管理のためのデータベース（DB）を持たない。「Issue/PRのラベル」と「コメントの履歴」のみを唯一の状態として利用する。
2. **既存LLM CLIの活用**
   ファイル編集、テスト実行、Git操作（PR作成等）の自律能力を持つ **Claude Code CLI (`claude`)** や **Gemini CLI** をそのままシェル経由でオーケストレーションする。
3. **安全なテスト機構（Sandboxモード）**
   検証用リポジトリを用意して向けるだけで、本物のGitHub Issue/PR操作を伴うパイプライン全体の挙動を安全にテスト・シミュレーションできる。
4. **抜け漏れ救済（Supervisorエージェント）**
   実行中ロックのタイムアウト（ハング状態）、自己修正の無限ループ、ラベルが剥がれた状態のIssueなどをバックグラウンドで監視・修復し、例外時には自動で人間の開発者へボールを引き渡す。

---

## 状態遷移フロー (Mermaid)

Issue作成からPRマージ、差し戻しループ、およびエラー時の対応までのフロー図です。

```mermaid
flowchart TD
    Start([開始]) --> SpecPending[agent:spec]
    
    subgraph SpecAgent [仕様定義エージェント]
        SpecPending --> |質問/ドラフト投稿 & agent:wait 付与| SpecWait[保留状態 agent:wait]
        SpecWait --> |ユーザーコメント / 15分以上経過した更新| SpecPending
        SpecPending --> |ユーザー承認 Approve| SpecApproved[PRD / 受け入れ基準確定]
    end
    
    SpecApproved --> DevPending[agent:dev]
    
    subgraph DevAgent [開発エージェント]
        DevPending --> Coding[コード編集]
        Coding --> LocalTest[ローカルテスト/Lint実行]
        LocalTest --> |エラーあり 自己修復| Coding
        LocalTest --> |テスト合格| CreatePR[PR作成]
    end
    
    CreatePR --> ReviewPending[PRに agent:review 付与]
    
    subgraph ReviewAgents [レビューエージェント群]
        ReviewPending --> GeneralReview[一般レビュー Gemini]
        ReviewPending --> SemanticReview[意味的・設計規約レビュー Claude]
        GeneralReview --> ReviewResult{レビュー結果}
        SemanticReview --> ReviewResult
        ReviewResult --> |指摘あり Failed| RejectReview[指摘コメント投稿]
        ReviewResult --> |指摘なし Passed| ApproveReview[PR承認]
    end
    
    RejectReview --> |開発へ差し戻し| DevPending
    
    subgraph QAAgent [QAエージェント]
        QAPending --> QATesting[統合・E2Eテスト実行]
        QATesting --> |テスト失敗 QA Failed| DevPending
        QATesting --> |テスト合格 QA Passed| MergePR[PRマージ & Issueクローズ]
    end
    
    MergePR --> End([終了])
    
    %% 監視・エラーハンドリング
    SpecAgent -.-> |タイムアウト/エラー| Triage[agent:triage]
    DevAgent -.-> |エラー/無限ループ| Triage
    ReviewAgents -.-> |実行エラー| Triage
    QAAgent -.-> |実行エラー| Triage
    
    Triage --> |人による調査・修正| Developer[開発者による介入]
    Developer --> |Specから再開| SpecPending
    Developer --> |Devから再開| DevPending
```

---

## パイプライン状態ラベル一覧

IssueおよびPRに付与される以下のラベルによって、どのエージェントにボールがあるかを一目で可視化する。

| ラベル名 | 担当エージェント | トリガーと動作内容 |
| :--- | :--- | :--- |
| **`agent:spec`** | **仕様定義 (SpecAgent)** | すべてのIssueの開始状態。ユーザーと仕様を壁打ちし、PRDと受け入れ基準（AC）を確定させる。 |
| **`agent:dev`** | **開発 (DevAgent)** | 仕様が確定したのち、ローカルテストを合格するまで自己修復を繰り返してPRを作成。レビュー/QAの指摘時もここに戻る。 |
| **`agent:review`** | **コードレビュー (ReviewAgents)** | 作成されたPRを、Gemini（一般・静的チェック）とClaude（意味的・設計規約チェック）の2つのエージェントで検証する。 |
| **`agent:qa`** | **検証 (QAAgent)** | PRマージ前の最終統合・E2Eテストを行い、マージを実行する。 |
| **`agent:triage`** | **例外監視 (SupervisorAgent)** | 実行中のハングやエラー、無限ループを検知した際のフォールバック状態。人間（開発者）による介入を待つ。 |
| **`agent:wait`** | **ユーザー待ち (Orchestrator)** | ユーザーの回答・確認待ち状態。この間はエージェント起動をスキップします。ユーザーのコメント投稿や、Supervisorによる本文編集等の検知（15分経過）で自動解除されます。 |

---

## ディレクトリ構成 (pnpm モノレポ構成)

```
/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.json
├── repo-map/                  # リポジトリ設定および構造マップ定義
│   ├── sandbox/               # サンドボックス検証環境用 (config.yaml, markdownマップ)
│   └── production/            # 本番運用環境用 (config.yaml, markdownマップ)
├── apps/
│   └── agent-runner/          # 対象リポジトリ群の定期クローラー兼エージェント起動デーモン
└── packages/
    ├── core/                  # 設定読み込み、型定義、ロガーなどの共通ユーティリティ
    └── agents/                # エージェント定義（プロンプト・コマンド組み立てロジック）
```

---

## ローカル開発と動作確認

### 事前準備
- Node.js v24 以上
- pnpm v10 以上
- `gh` (GitHub CLI) のインストールおよびログイン (`gh auth login`)
- `claude` (Claude Code CLI) のインストール

### パイプラインの起動
本オーケストレーターの実行には、リポジトリ設定とMarkdownマップを含むディレクトリの指定（`--repo-map-dir` または `-d`）が**必須**です。デフォルト値や自動補完はありません。

* **Sandbox（テスト検証用）**:
  ```bash
  pnpm dev:runner -- --repo-map-dir ./repo-map/sandbox
  ```
* **Production（本番運用時）**:
  ```bash
  pnpm dev:runner -- --repo-map-dir ./repo-map/production
  ```

*(単発で1サイクルのみ実行してテストしたい場合は `--once` または `-o` フラグを追加してください)*
  ```bash
  pnpm dev:runner --once -- --repo-map-dir ./repo-map/sandbox
  ```

---

## サンドボックス環境での検証手順

エージェントが実際にGitHub Issuesを検知して自律動作するか、以下の手順で安全にテストすることができます。

### 1. GitHub CLI のログイン確認
実行する環境で GitHub CLI が正常に認証されていることを確認してください。
```bash
gh auth status
```

### 2. パイプライン用ラベルの一括作成 (管理者権限で初回のみ実行)
通常実行するランナーの権限エラーを防ぐため、ラベル作成処理を分離しています。
リポジトリ管理権限を持つアカウントでログインし、以下のコマンドを実行して必要な `agent:*` ラベルを自動作成します。
```bash
# Sandbox環境用
pnpm labels:create -- --repo-map-dir ./repo-map/sandbox

# 本番環境用
pnpm labels:create -- --repo-map-dir ./repo-map/production
```

### 3. 検証環境の自動セットアップ
以下のコマンドを実行します。
```bash
pnpm sandbox:setup
```
- GitHub上に検証用リポジトリ `k-wa-wa/workflow-sandbox` がない場合は自動で作成します。
- 初期化コミットの後、テスト用のIssue（2つの数値の合計を計算するsum関数の実装）を `agent:spec` ラベル付きで自動作成します。

### 4. テスト検証の実行
以下のコマンドでランナーを 1 サイクルのみ単発実行します。
```bash
pnpm sandbox:run
```
- プロジェクト全体をビルドしたあと、クローラーを起動します。
- `agent:spec` の付いたテストIssueが検知され、仕様定義エージェント（Claude Code）が起動します。
- **エージェントの内部動作ログがリアルタイムにターミナルへストリーミング出力**されます。
- 仕様化の質問コメントが投稿され、ラベルが更新される様子などを観察できます。


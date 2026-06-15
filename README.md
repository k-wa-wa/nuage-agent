# nuage-agent

`nuage-agent` は、Claude Code や Antigravity CLI (`agy` / Gemini) などの自律型LLM CLIとGitHub Issue/PR駆動の、ステートレスかつ軽量な自動開発パイプラインである。

対象となるリポジトリ（`nuage-cluster`, `pechka` など）を定期的にクロールし、Issue/PRラベルとコメントをトリガーとして、仕様定義・開発・コードレビュー・QAの各エージェントを自動的にシェル経由で起動・実行する。

---

## 主な特徴

1. **完全ステートレス設計**
   状態管理のためのデータベース（DB）を持たない。「Issue/PRのラベル」と「コメントの履歴」のみを唯一の状態として利用する。
2. **既存LLM CLIの活用**
   ファイル編集、テスト実行、Git操作（PR作成等）の自律能力を持つ **Claude Code CLI (`claude`)** や **Antigravity CLI (`agy`)** をそのままシェル経由でオーケストレーションする。
3. **repo-mapによる複数リポジトリ対応**
   リポジトリのルールや構成マップ（repo-map）を記述することで、様々な技術スタックやディレクトリ構成のリポジトリに容易に対応可能。
4. **抜け漏れ救済（Supervisor）**
   実行中ロックのタイムアウト（ハング状態）、自己修正の無限ループ、ラベルが剥がれた状態のIssueなどをバックグラウンドで監視・修復し、例外時には自動で人間へボールを引き渡す。

---

## 状態遷移フロー (Mermaid)

Issue作成からPRマージ、差し戻しループ、およびエラー時の対応までのフローを記載する。

```mermaid
flowchart TD
    subgraph LEGEND["凡例"]
        direction LR
        L1["処理ステップ"]
        L2(["開始 / 終了"])
        L3{"分岐判定"}
        L4["A"] -->|"通常遷移"| L5["B"]
        L6["C"] -.->|"例外遷移"| L7["D"]
    end

    START([Issue起票])
    WAIT["agent:wait<br/>ユーザー返答待ち"]
    TRIAGE["agent:triage<br/>人間による調査"]
    MERGE(["マージ (ユーザー手動)"])

    subgraph SPEC_PH["仕様定義"]
        SPEC["agent:spec / SpecAgent"]
        SP1{"仕様に曖昧点?"}
        SP2["質問コメント投稿<br/>agent:wait 付与"]
        SP3{"タスク規模?"}
        SP4["PRD / AC確定<br/>Issue本文を更新"]
        SP5["サブIssue分割起票<br/>親Issueに agent:wait"]
        SPEC --> SP1
        SP1 -->|"Yes"| SP2
        SP1 -->|"No"| SP3
        SP3 -->|"通常規模"| SP4
        SP3 -->|"大規模"| SP5
    end

    subgraph DEV_PH["開発"]
        DEV["agent:dev / DevAgent (Issue)<br/>DevPRAgent (PR)"]
        D1["feature/issue-N ブランチ作成"]
        D2["コード実装"]
        D3{"テスト / Lint 合格?"}
        D4["PR作成<br/>agent:review 付与"]
        DEV --> D1 --> D2 --> D3
        D3 -->|"No (自己修復)"| D2
        D3 -->|"Yes"| D4
    end

    subgraph REVIEW_PH["レビュー"]
        REVIEW["agent:review (並列実行)"]
        RG["① GeneralReviewer <br/>バグ・セキュリティ・性能"]
        RS["② SemanticReviewer <br/>設計規約・影響範囲"]
        RC{"両方 PASSED?"}
        REVIEW --> RG & RS
        RG --> RC
        RS --> RC
    end

    subgraph QA_PH["QA"]
        QA["agent:qa / QAAgent"]
        Q1["PRブランチをチェックアウト"]
        Q2["統合・E2Eテスト<br/>セキュリティ監査"]
        Q3{"QA合格?"}
        QA --> Q1 --> Q2 --> Q3
    end

    START -->|"Supervisor: 未ラベルIssue → agent:spec 付与"| SPEC_PH
    SP2 --> WAIT
    SP5 --> WAIT
    WAIT -->|"ユーザーコメント + agent:wait 除去"| SPEC_PH
    WAIT -.->|"ユーザー活動 + 15分経過"| SPEC_PH
    SP4 --> DEV_PH
    D4 --> REVIEW_PH
    RC -->|"No: 指摘コメント → agent:dev"| DEV_PH
    RC -->|"Yes: postReviewCheck → agent:qa"| QA_PH
    Q3 -->|"Yes: 検証サマリ → マージ依頼"| MERGE
    Q3 -->|"No: → agent:dev"| DEV_PH

    SPEC_PH & DEV_PH & REVIEW_PH & QA_PH -.->|"agent:running 15分超過 (Supervisor)"| TRIAGE
    TRIAGE -.->|"人間が対応後 ラベル付け替え"| SPEC_PH
```

---

## パイプライン状態ラベル一覧

IssueおよびPRに付与される以下のラベルによって、どのエージェントにボールがあるかを一目で可視化する。

| ラベル名           | 担当フェーズ/コンポーネント       | トリガーと動作内容                                                                                                                                                                     |
| :----------------- | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`agent:spec`**   | **仕様定義 (SpecAgent)**          | すべてのIssueの開始状態。ユーザーと仕様を壁打ちし、PRDと受け入れ基準（AC）を確定させる。                                                                                               |
| **`agent:dev`**    | **開発 (DevAgent / DevPRAgent)**  | 仕様が確定したのち、ローカルテストを合格するまで自己修復を繰り返してPRを作成する（Issue担当）。また、レビュー/QAの指摘時にPRに付与され、指摘コメントを修正・再プッシュする（PR担当）。 |
| **`agent:review`** | **コードレビュー (ReviewAgents)** | 作成されたPRを、Antigravity CLI（一般・静的チェック）とClaude（意味的・設計規約チェック）の2つのエージェントで検証する。                                                               |
| **`agent:qa`**     | **検証 (QAAgent)**                | PRマージ前の最終統合・E2Eテストを行い、検証サマリを報告する。                                                                                                                          |
| **`agent:triage`** | **例外監視 (Supervisor)**         | 実行中のハングやエラー、無限ループを検知した際のフォールバック状態。人間による介入を待つ。                                                                                             |
| **`agent:wait`**   | **ユーザー待ち (Supervisor)**     | ユーザーの回答・確認待ち状態。この間はエージェント起動をスキップする。ユーザーのコメント投稿や、Supervisorによる本文編集等の検知（15分経過）で自動解除される。                         |

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
│   └── packages/
│       ├── core/              # 設定読み込み、型定義、ロガーなどの共通ユーティリティ
│       └── agents/            # エージェント定義（プロンプト・コマンド組み立てロジック）
```

---

## ローカル開発と動作確認

### 事前準備

- Node.js v24 以上
- pnpm v10 以上
- `gh` (GitHub CLI) のインストールおよびログイン (`gh auth login`)
- `claude` (Claude Code CLI) のインストール

### パイプラインの起動

本パイプラインの実行には、リポジトリ設定とMarkdownマップを含むディレクトリの指定（`--repo-map-dir` または `-d`）が**必須**である。デフォルト値や自動補完は無し。

- **Sandbox（テスト検証用）**:
  ```bash
  pnpm dev:runner -- --repo-map-dir ./repo-map/sandbox
  ```
- **Production（本番運用時）**:
  ```bash
  pnpm dev:runner -- --repo-map-dir ./repo-map/production
  ```

単発で1サイクルのみ実行してテストしたい場合は `--once` または `-o` フラグを追加する

```bash
pnpm dev:runner --once -- --repo-map-dir ./repo-map/sandbox
```

---

## サンドボックス環境での検証手順

サンドボックス環境での詳細な検証手順については、[docs/sandbox.md](file:///home/nixos/ghq/github.com/k-wa-wa/nuage-agent/docs/sandbox.md) を参照すること。

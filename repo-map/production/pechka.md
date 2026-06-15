## リポジトリ情報: pechka

**説明**: フロントエンド・ダッシュボードコンソール (Vite React + TypeScript)

### 技術スタック

- React
- Vite
- Tailwind CSS
- TypeScript
- npm

### 主要ディレクトリレイアウト

- `src/components`: UIコンポーネント (共通再利用部品)
- `src/pages`: 画面単位のコンポーネント (ページエントリー)
- `src/hooks`: カスタムReactフック (カスタムロジック)
- `src/api`: API通信クライアント定義
- `src/types`: 共有型定義ファイル
- `src/assets`: 画像、アイコンなどの静的アセット

### 設計規約 / ガードレール

- 全てのUIコンポーネントは Tailwind CSS を使用しスタイリングすること。
- コンポーネントは基本的にに関数コンポーネント（Functional Components）で定義すること。
- 型定義は `src/types/` 内に定義し、コンポーネント内での `any` の使用は厳禁。
- 新規機能の追加に伴い、必要に応じて `docs/` ディレクトリ配下の仕様書を更新すること。

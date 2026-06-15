## リポジトリ情報: nuage-cluster

**説明**: バックエンド・クラスターオーケストレーター (Node.js + Express + TypeScript)

### 技術スタック
- Node.js
- Express
- TypeScript
- Prisma (ORM)
- Docker
- npm

### 主要ディレクトリレイアウト
- `src/controllers`: HTTPリクエストハンドラー (コントローラー)
- `src/services`: コアビジネスロジック (サービス層)
- `src/models`: Prismaスキーマ / データベース定義
- `src/middlewares`: 認証・エラーハンドリングなどのミドルウェア
- `src/config`: 環境変数設定や定数定義
- `infra`: クラスターインフラ定義 (Kubernetesマニフェスト、Dockerfiles)

### 設計規約 / ガードレール
- データベースへの直接接続は行わず、必ず Prisma ORM を使用すること。
- コントローラー層にロジックを直接記述せず、必ず `src/services/` 内のサービス層に記述すること。
- N+1 クエリが発生しないよう、必要に応じて relation の include / select を適切に指定すること。
- Expressのルーティングでは、共通のエラーハンドリングミドルウェアに処理を受け渡すこと。

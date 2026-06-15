#!/usr/bin/env bash
set -euo pipefail

REPO="k-wa-wa/workflow-sandbox"
echo "=== Setting up sandbox repository: $REPO ==="

# Check GitHub CLI authentication
if ! command -v gh &> /dev/null; then
  echo "Error: gh (GitHub CLI) is not installed."
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: You are not authenticated with GitHub CLI. Please run 'gh auth login' first."
  exit 1
fi

# Try to view repository. If it doesn't exist, create it.
if gh repo view "$REPO" &>/dev/null; then
  echo "Repository $REPO already exists on GitHub."
else
  echo "Creating repository $REPO on GitHub..."
  # Create as public by default; if it fails, try private.
  gh repo create "$REPO" --public --confirm || gh repo create "$REPO" --private --confirm
fi

# Clone repository to temp directory to push initial commit if empty
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Cloning repository..."
if git clone "git@github.com:$REPO.git" "$TEMP_DIR" 2>/dev/null || git clone "https://github.com/$REPO.git" "$TEMP_DIR"; then
  cd "$TEMP_DIR"
  if [ ! -f README.md ]; then
    echo "Initializing repository with a README..."
    echo "# Workflow Sandbox" > README.md
    echo "This is a sandbox repository for nuage-agent workflows." >> README.md
    git checkout -b main 2>/dev/null || git checkout main
    git add README.md
    git commit -m "Initial commit"
    git branch -M main
    git push -u origin main
  else
    echo "Repository already contains files. Skipping initialization commit."
  fi
  cd - > /dev/null
else
  echo "Warning: Could not clone repository. Make sure your SSH keys or HTTPS credentials are set up."
fi

# Create test issue
ISSUE_TITLE="[機能追加] 2つの数値の合計を計算するsum関数の実装"
ISSUE_BODY=$(cat <<EOF
新規ファイル \`src/math.ts\` に、2つの引数を受け取ってその合計を返す \`sum\` 関数を実装してください。
また、その関数のユニットテストを \`test/math.test.ts\` に作成してください。

プロジェクトが正常にビルドでき、ローカルでテストが実行・通過することを確認してください。
EOF
)


echo "Checking for existing test issue..."
EXISTING_ISSUE=$(gh issue list --repo "$REPO" --search "$ISSUE_TITLE" --json number --jq '.[0].number' 2>/dev/null || true)

if [ -n "$EXISTING_ISSUE" ]; then
  echo "Test issue already exists: #$EXISTING_ISSUE"
else
  echo "Creating test issue with label 'agent:spec'..."
  # Note: The runner will automatically create the 'agent:spec' label on GitHub during startup if it doesn't exist yet.
  # So we create the issue, then we can add the label, or create the issue with the label.
  # If gh fails to create the issue because label doesn't exist, we create the issue first, then apply label,
  # but here we can try to create the label first or just create the issue without the label and let the label creator handle it.
  # Actually, we can create the label using gh cli first to avoid issues during issue creation.
  gh label create "agent:spec" --repo "$REPO" --color "fbca04" --description "Specification phase" --force 2>/dev/null || true
  
  ISSUE_URL=$(gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$ISSUE_BODY" --label "agent:spec")
  echo "Created test issue: $ISSUE_URL"
fi

echo "=== Sandbox setup complete! ==="
echo "You can now run the runner using:"
echo "  pnpm sandbox:run"

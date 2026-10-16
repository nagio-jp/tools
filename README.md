# nagio tools

開発で使うツールの置き場。Claude Code 用のものと、それ以外（他のエージェント用・汎用のツール）を同じリポジトリに置き、トップのディレクトリで区別する。

## 構成

```
claude/            Claude Code 用
  skills/<name>/   skill（.claude/skills/ に置いて使う）
<その他>/          Claude 以外のエージェント用・汎用のツール（用途ごとにトップにディレクトリを切る）
```

## claude/skills

| skill | 内容 |
|-------|------|
| [discover-cases](claude/skills/discover-cases/SKILL.md) | Web アプリ・サイト（静的 HTML、React・Vue・Next.js などの SPA）について、機能 → 画面 → E2E テストケースの順に洗い出し、抜けが 0 件になるまで埋める。人がレビューするのは最後に出る summary.md。成果物はローカルのファイルだけで、外部サービスには登録しない |

使いたい skill のディレクトリを、Claude Code の skill ディレクトリにコピーする（更新を追従したい場合はシンボリックリンクにする）。

```sh
# プロジェクト単位で使う場合
cp -R claude/skills/discover-cases <プロジェクト>/.claude/skills/

# すべてのプロジェクトで使う場合
ln -s ~/nagio-tools/claude/skills/discover-cases ~/.claude/skills/discover-cases
```

Claude Code で `/discover-cases <対象のルートディレクトリ> [起動中のアプリの URL]` を実行する。

### discover-cases のスクリプト

| スクリプト | 役割 | 依存 |
|------------|------|------|
| `sources.mjs` | 参考資料（仕様・API 定義・DB・既存テスト・認証など）の候補を種類ごとに検出する（問診の材料） | なし |
| `inventory.mjs` | 静的 HTML から操作できる要素を抽出する | なし |
| `routes.mjs` | ソースから画面のルートを拾う（Next.js・Nuxt・SvelteKit・React Router・Vue Router など） | なし |
| `crawl.mjs` | 起動中のアプリをブラウザで巡回し、描画後の画面から操作できる要素を抽出する | Playwright |
| `features.mjs` | 機能一覧（features.json）を「グループ → 機能」の木で出し、どの機能にも属さない画面を示す | なし |
| `coverage.mjs` | 全機能にケースがあるか・全画面と全要素がどれかの機能・ケースに属するかを判定し、summary.md を書き出す | なし |
| `review.mjs` | レビュー画面（マップ・関係図・表）を 127.0.0.1 で開く。人のフィードバックは review.json に保存し、`--pending` で対応待ちを出し、`--reply` / `--replies` で返信を書く | なし |

観点カタログは skill 直下の `perspectives.yaml`（カテゴリ・観点名・説明・当てはまる仕様の目安のフラットな配列）。ケースの `catalogPerspectives` と、レビュー画面の観点のタグに使う。

`crawl.mjs` を使うときだけ、Playwright を入れる（対象プロジェクトに Playwright があれば `--project <対象>` でそれを使える）。

```sh
cd claude/skills/discover-cases/scripts && npm install && npx playwright install chromium
```

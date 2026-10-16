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
| [test-cases](claude/skills/test-cases/SKILL.md) | 静的 HTML サイトの全画面を棚卸しし、抜けが 0 件になるまでテストケースを洗い出す。成果物はローカルの JSON だけで、外部サービスには登録しない |

使いたい skill のディレクトリを、Claude Code の skill ディレクトリにコピーする（更新を追従したい場合はシンボリックリンクにする）。

```sh
# プロジェクト単位で使う場合
cp -R claude/skills/test-cases <プロジェクト>/.claude/skills/

# すべてのプロジェクトで使う場合
ln -s ~/nagio-tools/claude/skills/test-cases ~/.claude/skills/test-cases
```

Claude Code で `/test-cases <HTML のルートディレクトリ>` を実行する。同梱のスクリプトは Node.js の標準モジュールだけで動くので、追加のインストールは要らない。

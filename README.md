# nagio tools

Claude Code で使う skill 集。

## skills

| skill | 内容 |
|-------|------|
| [test-cases](skills/test-cases/SKILL.md) | 静的 HTML サイトの全画面を棚卸しし、抜けが 0 件になるまでテストケースを洗い出す。成果物はローカルの JSON だけで、外部サービスには登録しない |

## 使い方

使いたい skill のディレクトリを、Claude Code の skill ディレクトリにコピーする。

```sh
# プロジェクト単位で使う場合
cp -R skills/test-cases <プロジェクト>/.claude/skills/

# すべてのプロジェクトで使う場合
cp -R skills/test-cases ~/.claude/skills/
```

Claude Code で `/test-cases <HTML のルートディレクトリ>` を実行する。スクリプトは Node.js の標準モジュールだけで動くので、追加のインストールは要らない。

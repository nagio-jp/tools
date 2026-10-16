# nagio tools

Claude Code・Codex などのコーディングエージェントで使う skill と agent の置き場。

## 構成

```
skills/<name>/          skill（Agent Skills 形式の SKILL.md。どのエージェントでも共通）
agents/claude/<name>.md Claude Code 専用のサブエージェント定義
agents/codex/<name>.toml Codex 専用のエージェント定義
```

- skill はエージェントごとに分けず、1 つの SKILL.md を共通で使う。特定のエージェントにしか無い機能（Claude Code の `$ARGUMENTS` など）に頼る書き方はしない
- エージェント固有の設定が必要なものだけ `agents/<エージェント名>/` に置く

## skills

| skill | 内容 |
|-------|------|
| [test-cases](skills/test-cases/SKILL.md) | 静的 HTML サイトの全画面を棚卸しし、抜けが 0 件になるまでテストケースを洗い出す。成果物はローカルの JSON だけで、外部サービスには登録しない |

## 使い方

使いたい skill のディレクトリを、エージェントの skill ディレクトリにコピーする（更新を追従したい場合はシンボリックリンクにする）。

| エージェント | プロジェクト単位 | すべてのプロジェクト |
|--------------|------------------|----------------------|
| Claude Code | `<プロジェクト>/.claude/skills/` | `~/.claude/skills/` |
| Codex | `<プロジェクト>/.agents/skills/` | `~/.agents/skills/` |

```sh
# 例: Claude Code と Codex の両方で、すべてのプロジェクトから使う
ln -s ~/nagio-tools/skills/test-cases ~/.claude/skills/test-cases
ln -s ~/nagio-tools/skills/test-cases ~/.agents/skills/test-cases
```

呼び出し方:

- Claude Code: `/test-cases <HTML のルートディレクトリ>`
- Codex: `$test-cases` で skill を指定するか、「<ディレクトリ> の全画面のテストケースを洗い出して」と頼む

skill に同梱のスクリプトは Node.js の標準モジュールだけで動くので、追加のインストールは要らない。

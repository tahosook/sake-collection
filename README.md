# sake-collection

手持ちのお酒が何本あって、それぞれ何なのかが、開けばすぐ分かるアプリ。
主目的は「どんなお酒を持っているかを知ること」。ローカルファーストの PWA（本人専用）。

## ドキュメント

- [要件定義書](docs/requirements.md)
- [全体設計書](docs/architecture.md)
- [ステップ1 詳細設計・受入条件](docs/step1-design.md)
- [ステップ2 詳細設計・受入条件](docs/step2-design.md)
- [ステップ3の残り・ステップ4 詳細設計](docs/step3-4-design.md)
- [Gemini 一括取り込み 機能詳細設計](docs/gemini-batch-import-design.md)
- [公開・運用手順書](docs/step4-operations.md)
- 開発ルール：[AGENTS.md](AGENTS.md)

## 検証

標準検証コマンドは `npm run verify`（データ検証＋型チェック＋lint＋テスト＋ビルド）。詳細は docs/step1-design.md を参照。

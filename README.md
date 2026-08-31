# EV充電 最安判定

EVカーナビ（NAVITIME）の充電器スクリーンショットから、最安の充電サービスを判定するPWAです。

## 機能

- スクショをGemini APIで解析し、対応認証サービスを抽出
- 料金マスターと照合して最安順に表示
- ZE1向け：充電速度を入力するとkWh課金との比較を表示
- モデル一覧をAPIから取得（プルダウン選択）
- AIによる最新料金調査（Google Search grounding）
- APIキー・料金マスターは各端末のlocalStorageに保存

## GitHub Pages デプロイ手順

1. このリポジトリをGitHubにプッシュ
2. Settings → Pages → Source: `main` ブランチ、`/ (root)` を選択
3. 数分後 `https://<username>.github.io/<repo>/` でアクセス
4. iPhone: Safariで開く → 共有 → ホーム画面に追加

## 初回設定

1. **設定**タブでGemini APIキーを入力・保存
2. **モデル一覧を取得**をタップ
3. 必要に応じて**利用サービス**のON/OFFを調整（ZESP3は初期OFF）

## 使い方

1. EVカーナビで充電器の詳細画面をスクショ
2. **解析**タブで画像を選択 → **AIで解析**
3. 最安の充電サービスを確認

## 注意

- 料金は参考値です。必ず公式情報を確認してください
- APIキーはlocalStorageに保存されます（端末・ブラウザごとに独立）
- ローカルファイル（file://）では動作しません。GitHub Pages等のWebサーバー経由で開いてください

## ファイル構成

```
├── index.html
├── manifest.json
├── service-worker.js
├── css/styles.css
├── js/
│   ├── app.js
│   ├── storage.js
│   ├── price-master.js
│   ├── price-engine.js
│   └── gemini-api.js
└── icons/
```

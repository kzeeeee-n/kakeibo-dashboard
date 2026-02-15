# KAKEIBO Dashboard

家計簿ダッシュボードアプリケーション - マネーフォワードCSV対応

## ファイル構成

```
HouseholdAccount/
├── index.html          # メインHTML（構造のみ）
├── styles.css          # スタイルシート（ダーク/ライトテーマ対応）
├── app.js              # アプリケーションロジック
├── firebase-config.js  # Firebase設定（空ならオフラインモード）
├── manifest.json       # PWAマニフェスト
├── sw.js               # Service Worker
└── README.md           # この仕様書
```

## 主な機能

### 1. CSV取り込み
- **マネーフォワードCSVのインポート**
- **対象月の自動検出**（ファイル名の日付範囲 → 単一日付 → YYYY-MMパターン → 現在月）
- **対象月の手動選択**（確認モーダルで変更可能）
- **上書き確認**：同月データが存在する場合、確認ダイアログ表示後に既存データを削除して再取り込み
- ドラッグ&ドロップ対応
- Shift_JIS / UTF-8 両対応

### 2. ダッシュボード
- **カレンダー式月選択**（◀▶ボタン + type="month" ピッカー）
- KPI表示（収入・支出・残高・貯蓄率・ポイント）
- 収入内訳
- 支出内訳（固定費・変動費分類、クリックで明細モーダル表示）
- 月次推移グラフ（選択月を基準に12ヶ月ローリング表示、データなし月は残高線非表示）
- 年間集計表（選択月を基準に12ヶ月ローリング表示）

### 3. お金の流れ（Sankeyダイアグラム）
- 収入源（金融機関名付き） → 保有金融機関 → 支出先の視覚化
- 横長レイアウトで見やすいデザイン
- 各ノードクリックで明細モーダル表示
  - 左列（収入源）→ 収入明細
  - 中央列（金融機関）→ 該当機関の全取引（収入+支出）
  - 右列（支出先）→ 支出明細

### 4. トレンド分析（選択月に連動）
- 固定費・変動費の推移（12ヶ月ローリング）
- 貯蓄率の推移（12ヶ月ローリング、目標25%ライン付き）

### 5. 設定
- 費目別予算設定
- 固定費・変動費の分類切替
- テーマ切替（ダークモード / ライトモード）
- 文字サイズ変更（小 / 中 / 大）
- データエクスポート・インポート（JSON形式）
- 全データ削除

## 使い方

### CSV取り込みフロー
1. 「CSV取込」ボタンまたはドラッグ&ドロップでファイルを選択
2. ファイル名から対象月を自動検出（例: `収入・支出詳細_2025-12-25_2026-01-22.csv` → `2026-01`）
3. 確認モーダルで対象月を確認・修正
4. 同月データが既存の場合は上書き確認ダイアログ表示
5. 「取り込み実行」で全データを指定月に集約

### 対象月の自動検出ルール
1. **ファイル名の日付範囲**（最優先）：後ろの日付を使用
   - 例: `_2025-12-25_2026-01-22.csv` → `2026-01`
2. **ファイル名の単一日付**
   - 例: `_2026-01-22.csv` → `2026-01`
3. **ファイル名のYYYY-MMパターン**
   - 例: `mf_202601.csv` → `2026-01`
4. **現在月**（フォールバック）

## データ構造

### IndexedDB ストア

#### `months` ストア
```javascript
{
  month: "2025/01",
  income: 160000,
  points: 1445,
  incomeDetail: { "給与（三井住友銀行）": 160000 },
  expenses: { "食費": 45000, "交通費": 12000 },
  sankeyFlows: [...],
  nodeColumn: { "給与（三井住友銀行）": 0, "三井住友銀行": 1, "食費": 2 }
}
```

#### `transactions` ストア
```javascript
// 支出取引
{
  id: 1,
  month: "2025/01",
  monthCat: "2025/01|||食費",
  date: "2026/01/22",
  content: "バルサミコ 支払",
  amount: -5491,
  account: "WAON",
  category: "食費",
  subcategory: "食費"
}

// 収入取引
{
  id: 2,
  month: "2025/01",
  monthCat: "2025/01|||income|||給与（三井住友銀行）",
  date: "2026/01/25",
  content: "給料",
  amount: 160000,
  account: "三井住友銀行",
  category: "income",
  subcategory: "給与"
}
```

#### `config` ストア
| key | value | 説明 |
|-----|-------|------|
| `budgets` | `{"食費": 50000, ...}` | 費目別予算 |
| `fixed` | `["住宅", "保険", ...]` | 固定費カテゴリ |
| `theme` | `"dark"` or `"light"` | テーマ設定 |
| `fontSize` | `1.0`, `1.15`, or `1.3` | フォントスケール |

## テーマ・表示設定

### ダークモード / ライトモード
- CSS変数 `[data-theme="light"]` で全カラーを上書き
- 設定は `config` ストアに永続化
- リロード後も設定を保持

### 文字サイズ
- CSS `zoom` プロパティでメインコンテンツ領域をスケーリング
- サイドバーは固定サイズのまま
- 3段階: 小(1.0) / 中(1.15) / 大(1.3)

## グラフ仕様

### 月次推移グラフ
- 棒グラフ：収入（緑）・支出（赤）
- 折れ線：残高（青）
- Y軸：10万、20万、50万等のきりの良い単位で自動調整
- マイナス値：ゼロラインを基準に下方向に描画
- 選択月を基準に12ヶ月ローリング表示、データなし月は棒0・残高線非表示

## 技術スタック

- **フロントエンド**: バニラJavaScript（フレームワーク不使用）
- **データベース**: Firestore（クラウド同期） / IndexedDB（オフラインモード）
- **認証**: Firebase Auth（Googleログイン）
- **スタイル**: CSSカスタムプロパティ（ダーク/ライト切替対応）
- **PWA**: Service Worker対応（オフライン利用可能）
- **チャート**: SVG生成による自作チャート
- **ホスティング**: GitHub Pages

## app.js 主要セクション

1. **ユーティリティ** - 数値フォーマット、トースト通知
2. **Firebase初期化** - Firestore / Auth の初期化（設定が空ならオフラインモード）
3. **データベース操作** - デュアルモード（Firestore / IndexedDB）CRUD + バッチ書き込み
4. **設定管理** - 予算・固定費・テーマ・フォントサイズの読み書き
4. **状態管理** - 月データの管理
5. **ナビゲーション** - ビュー切り替え
6. **KPI** - 主要指標カード描画
7. **収入パネル** - 収入内訳
8. **支出パネル** - 支出内訳（予算対比、クリックで明細表示）
9. **明細モーダル** - 支出/収入/金融機関の取引明細表示
10. **対象月選択モーダル** - CSV取込時の月確認（上書きチェック付き）
11. **12ヶ月レンジ・グラフ軸** - getMonthRange()、きりの良い軸計算
12. **トレンドグラフ** - 棒+折れ線（12ヶ月ローリング、マイナス対応）
13. **年間テーブル** - 12ヶ月ローリング集計
14. **Sankeyダイアグラム** - お金の流れ（クリックで明細表示）
15. **設定画面** - 予算・固定費・テーマ・フォント設定
16. **CSV解析** - MoneyForward形式パース（収入取引も保存）
17. **データ管理** - エクスポート・インポート・削除

## データモード

### オフラインモード（デフォルト）
`firebase-config.js` の `apiKey` が空の場合、IndexedDB のみで動作します。
Firebase の設定は不要で、ローカルブラウザにデータが保存されます。

### クラウド同期モード（Firebase）
Firebase を設定すると、Firestore でデータをクラウド同期し、家族で共有できます。

#### Firebaseセットアップ手順

1. **Firebaseプロジェクト作成**
   - [Firebase Console](https://console.firebase.google.com/) にアクセス
   - 「プロジェクトを追加」→ プロジェクト名を入力 → 作成

2. **Firestore Database を有効化**
   - 左メニュー「Firestore Database」→「データベースを作成」
   - ロケーション: `asia-northeast1`（東京）推奨
   - 「本番モードで開始」を選択

3. **Firestore セキュリティルール設定**
   - Firestore → ルール タブで以下を設定:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```

4. **Google認証を有効化**
   - 左メニュー「Authentication」→「始める」
   - 「Sign-in method」タブ → 「Google」→ 有効化
   - プロジェクトのサポートメール: 自分のメールアドレスを入力

5. **ウェブアプリを登録**
   - プロジェクト設定（歯車アイコン）→「マイアプリ」→「ウェブ」アイコン
   - アプリ名を入力 → 登録
   - 表示された設定値を `firebase-config.js` にコピー:
   ```javascript
   const FIREBASE_CONFIG = {
     apiKey: "AIza...",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abc123"
   };
   ```

6. **GitHub Pages にデプロイ**（Authentication の承認済みドメインに追加）
   - Authentication → Settings → 承認済みドメイン
   - `your-username.github.io` を追加

#### Firestore データ構造
```
users/{uid}/
├── months/{YYYY-MM}       # 月次サマリー
├── transactions/{autoId}  # 取引明細
└── config/{key}           # 設定（budgets, fixed, theme, fontSize）
```

## 開発環境

### ローカルサーバー起動
```bash
python3 -m http.server 5500
# または
npx http-server -p 5500
```

→ http://localhost:5500/HouseholdAccount/index.html にアクセス

---

**最終更新日**: 2026-02-15
**バージョン**: 4.0.0

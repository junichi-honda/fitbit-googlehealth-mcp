# fitbit-googlehealth-mcp

> Fitbit / Google Health の広範なヘルスデータを取得し、食事写真から食事ログを書き込める **Model Context Protocol (MCP) サーバー**。TypeScript 実装、Cloudflare Workers にデプロイ。Claude モバイル / Claude Desktop / Claude.ai から接続して使えます。

個人利用前提の設計で、fork してあなた自身の Google Cloud(または Fitbit)アプリ + Cloudflare アカウントで独立運用できます。バックエンドは env フラグ `HEALTH_PROVIDER` で **Google Health API v4** と **Fitbit Web API**(2026/09 停止)を切り替えられます。

## 何ができる

- **ヘルスデータの取得**(Read tool 16 個、Fitbit / Google Health 共通)
  - Activity(歩数・距離・カロリー・運動ログ)
  - Heart Rate(日別 + 1秒〜15分の Intraday)
  - Sleep v1.2(stage 含む)
  - Body(体重・体脂肪・BMI)
  - Nutrition(食事ログ・水分)
  - SpO2 / 呼吸数 / 皮膚温 / HRV / VO2 Max
  - デバイス情報
- **書き込み**(Write tool 8 個)
  - 食事(`log_food`・日本語 OK)
  - 水分・体重・体脂肪・活動・睡眠の手動ログ
  - `delete_food_log` で個別エントリ取り消し
- **⭐ `log_meal_photo`**: Claude モバイルで食事写真を添付 → Claude が視覚解析して栄養を推定 → 一括で食事ログに記録

---

## ⚠ 2026/09 の Fitbit Web API 停止について

Fitbit は **2026 年 9 月**に既存の Web API(`api.fitbit.com`)を完全停止し、後継の [Google Health API](https://developers.google.com/health)(`health.googleapis.com/v4`)に移行します。

- 既存の Fitbit OAuth トークンは **移行不可** → Google OAuth で再同意が必要(`pnpm run setup:google`)
- あわせて、Fitbit アカウント自体を **2026/05/19 までに Google Account に統合**必要(未統合は 2026/07/15 にデータ削除)。未統合のままだと Google OAuth で認可しても自分のデータが引けない
- 本実装は **Provider-agnostic 設計**で、Google Health API 実装(`src/providers/google-health/`)を同梱済み。`wrangler.toml` の `HEALTH_PROVIDER = "google"` で切り替える(未設定時は `fitbit` にフォールバック)
- ⚠ Google Health API 側のレスポンスフィールド名は公式に "actively evolving" とされており、本実装の整形処理は候補キーを寛容に探索する方式。実データでの検証手順は [`docs/journal.md`](docs/journal.md) の 2026-07-02 エントリを参照

詳細は [`docs/research.md`](docs/research.md) を参照。

---

## 前提

- **Fitbit アカウント**(**Google Account と統合済み**であること — 未統合だと Google Health API から自分のデータが引けない)
- **Google Cloud プロジェクト**(Google Health API を有効化。Fitbit フォールバックを使う場合のみ dev.fitbit.com の Personal App)
- **Cloudflare アカウント**(無料プランで十分)
- **Claude.ai アカウント**(Web から Custom Connector を追加、モバイルに自動同期)
- **Node.js 20+ / pnpm 9+**(ローカルビルド用)

---

## セットアップ(5 ステップ)

### 1. Clone + install

```bash
git clone https://github.com/tachibanayu24/fitbit-googlehealth-mcp.git
cd fitbit-googlehealth-mcp
pnpm install
```

### 2. Google Cloud プロジェクトと OAuth クライアント作成

1. [Google Health API を有効化](https://console.developers.google.com/apis/library/health.googleapis.com)(呼び出し元は Web Server)
2. [Audience ページ](https://console.developers.google.com/auth/audience)で User type = **External** を確認し、Test users に自分の Google アカウントを追加
3. [Data Access ページ](https://console.developers.google.com/auth/scopes)で Google Health API のスコープを追加して Save:
   - `googlehealth.activity_and_fitness` / `googlehealth.health_metrics_and_measurements` / `googlehealth.sleep` / `googlehealth.nutrition` の各 `.readonly` + `.writeonly`
   - `googlehealth.profile.readonly` / `googlehealth.settings.readonly`
4. [Credentials ページ](https://console.developers.google.com/apis/credentials)で OAuth client ID(**Web application**)を作成:
   - **Authorized redirect URI**: `http://127.0.0.1:8787/google/callback`
   - `Client ID` と `Client Secret` を控える(Secret は後から再表示できない)
5. **★ Publishing status を "In production"(本番環境)に昇格**([Audience ページ](https://console.developers.google.com/auth/audience))。

   > **「公開ステータス = 本番環境」と「アプリの検証」は別物**。混同しないこと。
   > - **7 日失効は "Testing" 固有の挙動**で、**本番環境に切り替えた時点で解消**される(アプリの検証完了は不要)。`Testing` のまま認可すると refresh token が 7 日で失効し、常駐 Worker の自動 refresh が毎週壊れる
   > - Google Health のスコープは機密/制限付きスコープ扱いのため、本番環境にすると**検証センター**に「ブランディングの検証」「データアクセスの検証(審査に提出)」が**要対応として表示される**。ただしこれは**未確認アプリ警告を消して一般公開する**ための手続きで、**自分ひとりで使う分には完了不要**。審査に提出せず放置してよい
   > - 認可時に「**Google はこのアプリを確認していません**」警告が出るが、**「詳細」→「(アプリ名)に移動(安全ではありません)」で続行**できる。未確認のままでも 100 ユーザー未満なら利用可能(個人利用は該当)
   >
   > つまり順序は「**本番環境に切替 → 検証センターの要対応は無視 → `pnpm run setup:google` で認可(警告を「詳細→続行」で通過)**」でよい。発行される refresh_token は本番環境なので長命になる(7 日で失効しない)

### 3. 初回認可と Cloudflare への投入

```bash
# 認可フローを開始(ブラウザが開く)。In production 昇格後に実行すること
export GOOGLE_CLIENT_ID=<your-client-id>
export GOOGLE_CLIENT_SECRET=<your-client-secret>
pnpm run setup:google
```

ブラウザで承認すると refresh_token が取れて、以降表示される `wrangler secret put` / `wrangler kv key put` コマンドをコピペして実行:

```bash
# wrangler.toml は .gitignore 対象。テンプレからコピーして自分の値を入れる
# (テンプレは HEALTH_PROVIDER = "google" 設定済み)
cp wrangler.toml.example wrangler.toml

# KV namespace(一回きり)
pnpm wrangler kv namespace create TOKENS
pnpm wrangler kv namespace create CACHE
# 返ってきた id を wrangler.toml の <your-...-id> に貼り付け

# Secret(MCP_SHARED_SECRET は URL-safe な hex を推奨)
pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -hex 32 | pnpm wrangler secret put MCP_SHARED_SECRET

# Google トークン(setup:google の出力をそのままコピペ、--remote 重要)
pnpm wrangler kv key put --remote --binding=TOKENS refresh_token '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS access_token  '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS expires_at    '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS user_id       'me'
```

<details>
<summary>旧 Fitbit Web API で運用する場合(2026/09 停止まで)</summary>

1. [dev.fitbit.com/apps/new](https://dev.fitbit.com/apps/new) で **Personal** タイプのアプリを作成(Callback URL: `http://127.0.0.1:8787/fitbit/callback`)
2. `export FITBIT_CLIENT_ID=... FITBIT_CLIENT_SECRET=...` して `pnpm run setup:fitbit`
3. Secret は `FITBIT_CLIENT_ID` / `FITBIT_CLIENT_SECRET` を投入、トークンの KV 投入は上と同じ(user_id は Fitbit の実 ID)
4. `wrangler.toml` の `HEALTH_PROVIDER` を `"fitbit"` にする(または行ごと削除 — 未設定時のデフォルトは fitbit)

Google ↔ Fitbit の切り替えは `HEALTH_PROVIDER` の変更 + 対応するトークンを TOKENS KV に入れ直して `pnpm deploy`。TOKENS は 1 プロバイダ分しか保持しないので、切り替え時は必ずトークンも入れ替えること。
</details>

### 4. デプロイ

```bash
pnpm deploy
# → https://fitbit-googlehealth-mcp.<your-sub>.workers.dev
```

### 5. Claude.ai に Custom Connector として登録

1. [claude.ai](https://claude.ai) で Settings → Connectors → **Add Custom Connector**
2. URL に `https://fitbit-googlehealth-mcp.<your-sub>.workers.dev/mcp/<MCP_SHARED_SECRET>` を貼る
3. 認証方式は **OAuth なし**(URL に secret を埋め込んでいるため)
4. 保存すると Claude モバイル / Desktop / Web に自動同期される

モバイルで新規会話を開き、`+` → Connectors → **Fitbit** を ON にして完了。

---

## ツール一覧

### Read(16)

| Tool | 引数 | 概要 |
|---|---|---|
| `get_profile` | — | プロフィール(単位系・身長・タイムゾーン) |
| `list_devices` | — | デバイス一覧(バッテリ、最終同期時刻) |
| `get_daily_summary` | `date?` | 歩数・カロリー・心拍ゾーン・active minutes |
| `get_activity_timeseries` | `resource, start, end` | steps / distance / calories 等の時系列 |
| `get_exercise_list` | `beforeDate?, limit?` | 運動ログ履歴 |
| `get_heart_rate_range` | `start, end` | 日別心拍(resting + zones) |
| `get_heart_rate_intraday` | `date, detailLevel` | Intraday(1sec/1min/5min/15min) |
| `get_sleep` | `date?` | Sleep v1.2(stage 含む) |
| `get_sleep_range` | `start, end` | 期間 Sleep |
| `get_body_log` | `start, end` | 体重 + 体脂肪 |
| `get_food_log` | `date?` | 食事ログ + 水分 + 栄養サマリ |
| `get_spo2` | `start, end` | 血中酸素飽和度 |
| `get_respiratory_rate` | `start, end` | 呼吸数 |
| `get_skin_temperature` | `start, end` | 皮膚温(nightly relative) |
| `get_hrv` | `start, end` | HRV(RMSSD) |
| `get_cardio_fitness` | `date?` | Cardio Fitness Score(VO2 Max) |

### Write(7)

| Tool | 引数 | 概要 |
|---|---|---|
| `log_food` | `foodName, calories, mealType, date?, nutritionalValues?` | 食事を 1 件記録(日本語 OK、PFC 保持) |
| `log_meal_photo` | `mealType, items[], date?, notes?` | **写真解析結果を一括で記録**(Claude が視覚解析 → items を渡す前提) |
| `log_water` | `amountMl, date?` | 水分(ml) |
| `log_weight` | `weightKg, date?, time?` | 体重 |
| `log_body_fat` | `fatPercent, date?, time?` | 体脂肪率 |
| `log_activity` | `activityId or activityName+manualCalories, startTime, durationMs, date?, distanceKm?` | 手動で運動ログ |
| `log_sleep` | `startTime, durationMs, date?` | 手動で睡眠ログ |

### Delete(6)

| Tool | 引数 | 概要 |
|---|---|---|
| `delete_food_log` | `logId, date?` | 食事エントリ削除 |
| `delete_water_log` | `logId, date?` | 水分エントリ削除 |
| `delete_weight_log` | `logId, date?` | 体重エントリ削除 |
| `delete_body_fat_log` | `logId` | 体脂肪エントリ削除 |
| `delete_activity_log` | `logId, date?` | 運動ログ削除 |
| `delete_sleep_log` | `logId, date?` | 睡眠ログ削除 |

### Meal preset(4)

作り置き用の再利用可能な栄養プロファイルを MCP サーバー側(Workers KV)に保存して、ログ時に栄養素込みで Fitbit へ投入する仕組み。Fitbit の Create Food API は栄養素を保存しない仕様なので、PFC 追跡にはこちらを使う。

| Tool | 引数 | 概要 |
|---|---|---|
| `save_meal_preset` | `name, calories, protein?, carbs?, fat?, fiber?, sodium?, sugar?, notes?` | preset を保存(同名で上書き) |
| `list_meal_presets` | — | 保存済み preset 一覧 |
| `log_preset` | `name, mealType, date?, amount?` | preset を今日/指定日の食事ログに記録 |
| `delete_meal_preset` | `name` | preset 削除(既存 log には影響なし) |

全 `date?` は省略時 **JST の今日** にフォールバック。Tool 総数 33(Read 16 + Write 7 + Delete 6 + Preset 4)。

---

## 使用例

### 写真で食事記録
> 🤳 モバイルで昼食の写真を添付  
> 🧑 「これを lunch で記録して」  
> 🤖 Claude が視覚解析 → `log_meal_photo` を呼ぶ  
>
> ```
> Logged 3 item(s) for Lunch on 2026-04-22:
>   • 親子丼(1人前、推定 680 kcal、高信頼度)
>   • 味噌汁(1杯、推定 40 kcal、中信頼度)
>   • 小鉢(ほうれん草、推定 60 kcal、中信頼度)
> ```

### 睡眠の分析
> 🧑 「昨日の睡眠を見せて」  
> 🤖 Claude が `get_sleep` を呼び、stage の内訳や minutesAsleep / efficiency を要約

### 活動トレンド
> 🧑 「先週の歩数どうだった?」  
> 🤖 `get_activity_timeseries(resource: "steps", start: ..., end: ...)` → 週平均・目標達成率を計算

---

## ローカル開発

```bash
# ローカルで Worker 起動(local KV、local secret)
echo 'MCP_SHARED_SECRET=dev-secret' > .dev.vars
pnpm dev

# Lint / Format / Typecheck / Test
pnpm lint
pnpm format
pnpm typecheck
pnpm test

# MCP Inspector で tool schema 確認
npx @modelcontextprotocol/inspector
# URL: http://127.0.0.1:8787/mcp/dev-secret
# CF-Connecting-IP ヘッダで 160.79.104.5 を送る設定が必要
```

---

## アーキテクチャ

```
Claude mobile / Desktop / Web
      │ (public URL: Streamable HTTP)
      ▼
Anthropic Cloud  (outbound CIDR 160.79.104.0/21)
      │
      ▼
Cloudflare Workers  /mcp/<SECRET>
  ├─ guard middleware  (SECRET + CIDR allowlist)
  ├─ @hono/mcp  Streamable HTTP transport
  └─ McpServer
       ├─ HealthProvider interface   ← HEALTH_PROVIDER env で選択
       │   ├─ GoogleHealthProvider   (health.googleapis.com/v4)
       │   │    ├─ Google OAuth refresh (Workers KV: TOKENS)
       │   │    └─ GoogleHealthClient (fetch wrapper, 401/429 retry)
       │   └─ FitbitProvider         (api.fitbit.com、2026/09 停止)
       │        ├─ OAuth refresh (Workers KV: TOKENS)
       │        └─ FitbitClient (fetch wrapper, 401/429 retry)
       └─ tools/read/*, tools/write/*
            └─ getCached → Workers KV: CACHE  (TTL 1h)
```

- **Provider 抽象**: ツール層は `HealthProvider` interface 越しに呼ぶだけなので、Google 移行でツール定義・キャッシュ・セキュリティ層は無変更
- **Google Health API は全メトリクスが単一リソース** `users/me/dataTypes/{dataType}/dataPoints` の `:list` / `:dailyRollUp` / PATCH / `:batchDelete` に集約される。`GoogleHealthProvider` がレスポンスを Fitbit 時代の shape に整形して返す
- **Cache**: Read 結果を KV に 1h キャッシュ(プロバイダ切り替え直後は最大 1h 前プロバイダの結果が残ることに注意)
- **画像は MCP サーバーを通らない**: Claude が視覚解析して `items[]` を引数として渡す

---

## セキュリティ

**個人用シンプル認証** の構成です。

- **SECRET + Anthropic CIDR の 2 層防御**:
  1. URL パス末尾の `<MCP_SHARED_SECRET>` が一致しなければ 401(constant-time 比較)
  2. `CF-Connecting-IP` が `ALLOWED_CIDRS` env の CIDR のいずれにも属さなければ 403
- Anthropic outbound CIDR は公開情報 `160.79.104.0/21`。claude.ai 経由のリクエストだけを通す
- `MCP_SHARED_SECRET` は Workers Secret に保管、コードには入れない
- ローテーションは `wrangler secret put` + claude.ai の URL 更新だけで完結。Fitbit トークンに影響なし

**脅威モデル**: SECRET が漏れて攻撃者が Anthropic CIDR 内からアクセスできる場合のみ、あなたの Fitbit データ閲覧・偽書き込みが可能。Fitbit アカウント自体の乗っ取りは不可(refresh_token は Worker 内にのみ存在)。

複数ユーザー配布が必要なら `@cloudflare/workers-oauth-provider` で本格 OAuth AS 化する方針に切り替え可能(本リポはそれを選んでいない — 個人用最小構成)。

---

## 既知の制約

### Google Health provider(2026-07 実装、実データ検証中)
- **レスポンスのフィールド名は寛容に探索**: Google Health API は "actively evolving"(2026-05-26 にもスコープ分割の breaking change)のため、整形処理は候補キーを順に探索し、外れたフィールドはエラーではなく `undefined` になる。値が欠ける場合は `docs/journal.md`(2026-07-02)の検証チェックリストを参照
- **`get_activity_timeseries` は steps / distance / calories / activityCalories のみ**: floors・elevation・sedentary/active minutes 系は Google Health に対応データ型がなく、明示エラーを返す
- **Intraday 心拍はクライアント側ダウンサンプル**: Google はネイティブ ~5 秒サンプルを返すだけで detailLevel バケットが無いので、1min/5min/15min は Worker 内で窓平均する(`1sec` はネイティブ粒度そのまま)
- **皮膚温は絶対値(℃)**: Fitbit の nightly relative と意味論が違うため、`get_skin_temperature` は `value.absolute` に格納する(`nightlyRelative` は Fitbit provider 用に温存)
- **logId は数値前提**: Google の data point id が数値でない場合、read はハッシュ代替で表示を続けるが `delete_*` はその id を解決できない(journal の検証項目)

### Fitbit provider 固有(2026/09 停止までのフォールバック用)

#### 食事ログ周り
- **Search Foods 障害(2025/11〜)**: Fitbit 公式 API の `/foods/search` が不安定。本実装は意図的に `foodName` + `calories` 直書きしか使わない
- **`POST /foods/log.json` は `unitId` を必須化**(`unitName` は受け付けない)。本実装は foodName モードで `unitId: 304` (= serving) を自動付与
- **栄養素キー名が非対称**(実測結果、2026-04):
  - `protein` / `totalFat` / `totalCarbohydrate` / `dietaryFiber` / `sodium` / `sugars` — これらのキー名で送らないと Fitbit 側で無視される
  - 旧 docs の `nutritionalValues.protein` 形式も、`proteinGrams` / `totalCarbs` 等も 2026-04 時点では効かない
- **Create Food(カスタム食品)は calories のみ保存**:protein/carbs/fat を送っても silent drop される。本実装は `create_custom_food` を廃止し、栄養素を保持したい場合は **MCP サーバー側プリセット**(`save_meal_preset` + `log_preset`)で foodName 経路に流している
- **sugar は `get_food_log` の echo に含まれない** — 保存されたかは視認できない

#### Intraday(心拍数)
- **運動ログがある日は Fitbit が intraday の dataset を pruning**することがある(実測:運動日は朝〜夕方の dataset が欠落、運動無しの日は終日揃う)。zone summary は別パイプラインで残るので `get_heart_rate_range` はフォールバックに使える
- **1sec 粒度**:運動記録中以外は 1 秒粒度が保証されない

#### その他
- **Sleep は v1.2 のみ**(v1 は deprecated)
- **レート制限**: 150 req/h/user。429 時は `Retry-After` を 30s までクランプして 1 回リトライ(Google provider も同じリトライ構造)

### 共通
- **Claude モバイルから Custom Connector の新規追加は不可**: 必ず claude.ai(Web)から追加
- **全 read に 1h キャッシュ**: LLM の連続呼び出しでレート制限を突き抜けないための温存策。プロバイダ切り替え直後は前プロバイダのキャッシュが最大 1h 残る

---

## 開発ノート

- [`docs/research.md`](docs/research.md) — 設計前に行った調査(Fitbit API の現状、MCP / Claude モバイルの仕様、先行実装サーベイ、出典付き)
- [`docs/journal.md`](docs/journal.md) — 開発ログ(決定理由、ハマり、使用感)
- [`scripts/diagnose-food-log.ts`](scripts/diagnose-food-log.ts) — Fitbit の foodLog API の挙動(栄養素キー名など)を直接確認するための reproducer。API が再び形を変えた時にパターン追加して実行すれば原因特定できるよう in-tree 保持

---

## Contributing

Issue / Pull Request 歓迎。設計判断は [`docs/journal.md`](docs/journal.md) を参照してください。

---

## License

[MIT](LICENSE)

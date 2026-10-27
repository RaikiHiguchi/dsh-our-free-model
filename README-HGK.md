# README-HGK — HGK が OpenAI 互換 local forward を固定 model で使う手順

この文書は、このフォーク（`dsh-our-free-model`）に追加された HGK 専用モードの利用手順書である。HGK が既存の OpenAI 互換 local forward を使い、model を一つ明示して呼び出すための条件と境界を書く。通常モードの説明は [README.md](README.md) にあり、この文書はそれを置き換えない。

## 1. 先に知っておくこと

### 1.1 この文書が書くこと

HGK 専用モードは `forward.hgkControlled: true` を設定したときだけ働く。この設定が `false`（既定）なら、通常モードの forward は変わらない。

HGK 専用モードで保証するのは、このプラグインの forward が「HGK が指定した model 一つの宛先」だけへ要求を送る形に絞られる、ということである。プラグインが解決した宛先 gateway より先で、その provider が内部でどの経路を選ぶかは、このプラグインからは固定できず、観測もできない。固定できたとは主張しない。

### 1.2 根拠にした資料と状態

次の表は、この文書が何を読んで書かれたかを分ける。

| 区分 | 内容 |
| --- | --- |
| 読んだ原典 | 作業ツリーの [src/hgk.js](src/hgk.js)、[src/forward.js](src/forward.js) の差分、[index.js](index.js) の差分、[src/store.js](src/store.js) の差分、[package.json](package.json)、[scripts/test-all.mjs](scripts/test-all.mjs) の差分 |
| 起点・upstream HEAD | `38648bf0ebecc63563e2e3324fbed4d323a442ac`。開始時のローカル参照と、作業中の `git ls-remote upstream refs/heads/main` が一致 |
| 検証 | HGK の非通信試験と必要回帰を実行済み（§10） |
| 実推論 | 外部 provider への実推論は 0 件。現用 DSH・Hegemonikon・資格・設定は変更していない |

## 2. 成立条件

HGK 専用モードが使えるのは、次の条件が全部そろうときである。

1. `forward.hgkControlled` が `true` である。
2. `forward.enabled` が `true` である。`false` なら 503 を返す。
3. 呼び出し元が同じ機械の loopback アドレス（`127.0.0.1` など）から接続する。
4. 呼び出し元が既存の forward key を提示する（§4.3）。
5. LAN 公開（`forward.lan.enabled`）が `false` である。
6. 出口中継（egress relay）が無効で、かつ動作していない。
7. 呼び出す model が `/v1/hgk/routes` の一覧にある実在の経路 id で、観測上の可用性が `unavailable`・`region-blocked`・`throttled` のどれでもない。

どれかが欠けると要求は拒否される（§7）。通常モードへ静かに戻ることはない。

## 3. 有効にする手順

この手順は、プラグインが動いている DSH にすでに forward key が発行されていることを前提とする。key の値はこの文書に書かない。

### 3.1 設定する項目

既存の forward 設定（`enabled`・`host`・`port`）をそのまま使う。追加された項目は `forward.hgkControlled` の一つだけである。

設定 API は `POST …/api/our-free-model/settings` で、本文は次の形になる。

```json
{ "forward": { "enabled": true, "hgkControlled": true } }
```

`host` と `port` を変えるなら、同じ `forward` 内に書く。`host` は loopback のアドレスに限られる。既定は `127.0.0.1`、ポートの既定値は `18899` である（[src/store.js](src/store.js) の `SETTINGS_INITIAL`）。

`lan.enabled` が `true` の状態で `hgkControlled: true` を送ると、設定 API は 400 `HGK_LAN_REJECTED` で拒否する。先に LAN 公開を切ること。

設定 API を DSH のどのアドレスで呼ぶかは、この文書では確認していない。

### 3.2 port の扱い

通常モードの forward は、指定したポートが塞がっていると近くの番号へずらして起動する。HGK 専用モードはずらさず、指定したポートで一度だけ待ち受ける。使用中なら起動に失敗する。HGK 側の接続先と実際の待受を食い違わせないための違いである。

### 3.3 切替の反映

設定を変えると、listener は `hgkControlled` の値を比べて作り直される（[index.js](index.js) の `syncForward`）。通常モードと HGK 専用モードを行き来すると、そのたびに待受が再起動される。切替直後の要求は、再起動の途中であれば失敗することがある。

## 4. 呼び出し方

### 4.1 使える入口は三つだけ

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/v1/hgk/routes` | HGK が使える経路と、その観測の一覧 |
| GET | `/v1/models` | 同じ経路の OpenAI 形式の一覧（`id` が経路 id、`owned_by` が provider） |
| POST | `/v1/chat/completions` | 実際の補完。streaming も使える |

これ以外のパス・メソッドは 404 `HGK_ENDPOINT_UNSUPPORTED` 相当で拒否される。通常モードにある Gemini 形式や Anthropic 形式の入口、製品附属の追加ルート（`handleRequest`）は、HGK 専用モードでは働かない。

### 4.2 model の指定

`model` には、`/v1/hgk/routes` の `route` と完全に同じ文字列を渡す。

次は拒否される。

- 一覧にない id（未知の経路）。
- `combo:` で始まる id、`openrouter/free`、および `auto`・`automatic`・`router`・`round-robin` を区切り付きで含む id。自動選択や自動 fallback になりうるためである。この名前による拒否は保守的で、`open_router` 配下の明示モデルも拒否する。名前に表れない provider 内部の自動振分けは判断しない。
- 前後に空白がある id。
- 通常モードが受け入れる思考強度の接尾辞付きの id。HGK 専用モードでは別名として扱い、受け入れない。

### 4.3 認証

呼び出し元は forward key を `Authorization: Bearer <key>` か `x-api-key: <key>` で提示する。key は定数時間で比較される。key が空の設定では、常に認証に失敗する。

key の取得は既存の API（`GET …/api/our-free-model/forward/key`）による。key の値を文書・履歴・コマンド例へ書かないこと。

### 4.4 コマンド例

次は書き方の例であり、実行していない。`<…>` は利用者が自分の値へ置き換える。

```powershell
# key は環境変数に置く。値そのものをコマンドや履歴に書かない。
$base = "http://127.0.0.1:<port>"
$headers = @{ Authorization = "Bearer $env:OFM_FORWARD_KEY" }

# 1. 使える経路と観測を読む（通信先は local forward のみ）
Invoke-RestMethod -Uri "$base/v1/hgk/routes" -Headers $headers

# 2. 経路 id を一つ選び、固定して呼ぶ
$body = @{
  model    = "<routes の route をそのまま>"
  messages = @(@{ role = "user"; content = "<依頼>" })
} | ConvertTo-Json -Depth 5
Invoke-WebRequest -Uri "$base/v1/chat/completions" -Method Post -Headers $headers `
  -ContentType "application/json" -Body $body
```

2 の呼び出しは実際に上流へ送る。この文書の作成時には行っていない。

## 5. 応答と観測

### 5.1 `x-hgk-resolved` ヘッダ

補完の応答には、解決結果を JSON にして base64url で符号化した `x-hgk-resolved` ヘッダが付く。経路の解決と可用性の確認を通過した後に付けられる。内容は §5.2 の行と同じ項目である。

このヘッダは、プラグインが解決した宛先を HGK が確かめるための手がかりである。上流がその宛先でどう処理したかの証明ではない。

### 5.2 `/v1/hgk/routes` の項目

| 項目 | 内容 |
| --- | --- |
| `provider`・`model`・`route` | 解決された provider、その provider 内の model、HGK が渡す経路 id |
| `destination` | 要求を送る URL。資格情報・検索文字列・断片を含む URL は使わず、そのような宛先の経路は解決自体を拒否する |
| `lane` | `keyless-free`・`keyless`・`credential` のいずれか（§6） |
| `source` | 経路を解決した根拠の種類（例: カタログの cache）。分からなければ `null` |
| `availability`・`availabilitySource`・`probedAt` | 保存済みの観測。`availability` は `available`・`unavailable`・`region-blocked`・`throttled`・`unknown`。`availabilitySource` は `manual`・`listing`・`probe` のどれか、または `null`。`probedAt` は観測時刻、なければ `null` |
| `dataUse`・`training`・`retention`・`charge`・`quota` | 現状は常に `null`（不明） |
| `policy` | `retries: 0`、`redirects: false`、`fallback: false`、`roundRobin: false`、`recovery: false` |
| `outputTrust` | 常に `untrusted` |

観測は保存済みの値を読むだけである。`availabilitySource` は既存の分類を保つため、未測定でも `probe` や `listing` になることがある。測定の有無は `probedAt: null` と `availability: unknown` で区別する。この一覧を読んでも、新しい探測や通信は起こらない。`probedAt` が古い、あるいは `unknown` の経路は、いま使えるかどうか分からない経路として扱うこと。

### 5.3 `null` の意味

`dataUse`・`training`・`retention`・`charge`・`quota` が `null` なのは、「該当なし」ではなく「このプラグインは値を持たない」という意味である。無料・学習に使われない・保持されないと読んではならない。HGK がこれらを判断に使うなら、別の根拠が要る。

## 6. 経路の種類（lane）と無料の扱い

`lane` は経路の出どころを区別する。区別の目的は、無料だと推定できる経路と、そうでない経路を混ぜないことにある。

| lane | 対象 | 無料についての扱い |
| --- | --- | --- |
| `keyless-free` | OpenCode のカタログの経路、Kilo の公開 gateway の経路 | キーなしで使える無料枠だと、カタログ上は推定される。ただし `charge` と `quota` は `null` なので、課金されないことは保証しない |
| `keyless` | 集約（aggregate）provider のうち認証が不要なもの | キーは要らないが、無料とは推定しない |
| `credential` | 集約 provider のうち認証が必要なもの | 資格情報を使う経路であり、無料とは推定しない |

`keyless-free` の無料という推定を、`keyless` や `credential` へ広げてはならない。

次の経路は HGK 専用モードの一覧に出ず、呼び出しても拒否される。内部の経路を、HGK 側から検証できないためである。

- Kilo・aggregate 以外で `channel` を持つ経路（EAC・各種 subscription など）。ここで拒否されるのは HGK 専用モードだけである。通常モードでの利用は変わらない。
- `combo:`・自動選択・自動 fallback に当たる経路（§4.2）。

## 7. 拒否される条件

次は、コードから読み取った拒否の一覧である。応答の状態コードの欄は、経路に入る前の門で返すものに限り、コードから確認している。

| 条件 | 状態コード（確認できたもの） | 識別名（コード内） |
| --- | --- | --- |
| loopback 以外からの接続、LAN 公開が有効、中継の目印ヘッダ付き、`hgkControlled` が食い違う | 403 | `HGK_LOCAL_ONLY` |
| `forward.enabled` が `false` | 503 | `HGK_DISABLED` |
| key が合わない、または空 | 401 | `HGK_AUTH_REQUIRED` |
| 三つの入口以外 | 404 | `HGK_ENDPOINT_UNSUPPORTED` |
| 起動時に `hgkControlled` かつ LAN 公開が有効、または HGK 供給層が無い | 起動を拒否（400 相当の内部エラー） | `HGK_CONFIGURATION_REJECTED` |
| model が文字列でない・空白付き・接尾辞付き | 補完の処理に入ってから拒否 | `HGK_EXPLICIT_ROUTE_REQUIRED` |
| 一覧にない model | 同上 | `HGK_UNKNOWN_ROUTE` |
| 解決できない経路（EAC など内部経路、`combo` など） | 同上 | `HGK_ROUTE_UNSUPPORTED` |
| 出口中継が有効または動作中 | 同上 | `HGK_EGRESS_UNSUPPORTED` |
| 観測が `unavailable`・`region-blocked`・`throttled` | 同上 | `HGK_ROUTE_UNAVAILABLE` |
| 上流の失敗 | 同上 | `HGK_UPSTREAM_FAILED` |

注意が二つある。

- 経路解決後の拒否も既存の失敗分類を通る。未知の経路は 404、非対応経路は 400、可用性による拒否と出口中継は 503、上流失敗は 502 となる。stream の開始後に失敗した場合は、HTTP 200 のまま失敗イベントになることがある。呼び出し側は状態コードだけでなく、本文や stream の失敗も受け入れる設計にすること。
- HGK 専用モードでは、門の段階で投げた失敗の本文を `HGK_REQUEST_REJECTED` という汎用の文字列に置き換え、ログにも `HGK_REQUEST_FAILED` だけを残す。上流の詳細な失敗文が外へ漏れないようにするためである。

HGK の三つの入口の応答には `x-should-retry: false` が付く。ただし呼び出し側でも SDK の再送回数を 0 に設定すること。ヘッダだけで任意の SDK の動作は強制できない。

## 8. 経路を一つに固定する仕組みと、その限界

### 8.1 プラグインが行うこと

補完の一回ごとに、プラグインは次の状態で既存の変換・送信・解析を再利用する。

- カタログを、指定された経路の一行だけにする。
- 経路の所属（membership）を、その一行だけにする。
- `streamRecovery` を `false` にする。
- `tokenSaver` を無効にする。
- 使用量・会話の記録、警告の出力を行わない（本文や警告を監査へ保存しない）。
- 失敗の本文を `HGK_UPSTREAM_FAILED` に置き換え、上流の詳細を外へ出さない。

カタログと所属を一行に固定し、combo・自動経路を送信前に拒否する。非通信試験では、拒否時に模擬上流への送信件数が増えないことを確認した。

### 8.2 言えないこと

- 解決された宛先の gateway より先で、その provider が内部でどの model・どの経路へ振り分けるかは、このプラグインからは固定も確認もできない。
- 再送・自動続行・redirect なしは、既存送信コードと非通信 fixture の範囲で確認した。実 provider への接続や、その内部の動作を確認したものではない。
- HGK 側で要求全体の期限と再送 0 を設定すること。回復処理を無効にすると adapter の全体時限も無効になり、残るのは送信処理の無通信期限と呼び出し側の中断である。
- `user`・`conversation` には秘密を入れないこと。既存の上流 session 対応表は、これらの識別子をローカルに保存する。宛先 URL の path に資格情報を埋め込まないこと。既知の API key 混入は拒否するが、任意の path の秘密性は判断しない。
- 可用性の観測は、上流の状態そのものではなく、ある時点で保存された結果である。

## 9. 外部出力の取り扱い

応答は `outputTrust: untrusted` の外部出力である。内容を信用して実行・保存・権限の判断に使わず、HGK 側で受入の判断をすること。このプラグインは、出力の安全性・正しさ・提供元の保持方針について何も保証しない。

## 10. 試験と検証の状況

[hgk-test.mjs](<scripts/hgk-test.mjs>) は [test-all.mjs](<scripts/test-all.mjs>) の `hgk` suite に登録している。Node v24.22.1 で以下を実行した。非通信とは、loopback の模擬上流だけを使い、外部 provider へ接続しない試験を指す。

| 検査 | 結果と射程 |
| --- | --- |
| `node scripts/hgk-test.mjs` | 8/8 合格。固定宛先、経路拒否、未知保持、可用性変化、LAN 拒否、失敗・分割 stream の秘密除去、プラグイン入口を確認。外部接続試行 0 |
| 最終修理後の必要回帰 | `forward`・`aggregate-wiring`・`subscription-completion`（29/29）・`retry-safety`・`forward-boot` 合格 |
| `node scripts/test-all.mjs --mode contributor` | 96/100 suites 合格。最終秘密除去修理の前に実行し、影響部分は上記で再実行 |
| `reload`・`channel-source` | 依存パッケージ Cordis／TypeScript 不足で不合格。依存導入や現用環境の変更はしていない |
| `legacy-upgrade` | ローカル fixture の取得失敗で不合格。未変更の上流基底でも同種の取得失敗を再現したが、失敗した assertion の位置は異なる |
| `magpie-policy` | `api/plugins/github` の内容検査で不合格。未変更の上流基底でも同じ箇所で再現 |
| 構文・差分形式 | `node --check`、`git diff --check` 合格 |
| 型検査 | TypeScript がないため未実施 |
| `node scripts/build-manifest.mjs --check` | 変更バイトと上流の署名付き記録の不一致で不合格。署名リリースは今回対象外。既存署名・公開鍵・版は変更しない |
| 実環境への導入・provider 実推論 | 未実施。管理されたソース導入が次工程。現用環境を変更していない |

署名付きのアプリ内更新用成果物としては未成立である。この fork は §12.4 の `managed` 導入を前提に扱い、上流の署名付きリリースと同一視しない。

## 11. 通常モードとの関係

`hgkControlled: false` なら、既存の forward は従来どおり働く。通常モードで使えるもの（`combo`、思考強度の接尾辞、Gemini 形式・Anthropic 形式の入口、LAN 公開、出口中継、EAC や subscription の経路など）は、HGK 専用モードにだけ制限がかかる。

ただし HGK 専用モードを有効にしている間は、次が変わる。

- LAN 公開（`lan.enabled`）の中継は、`hgkControlled` が `true` のとき起動しない（[index.js](index.js) の `syncRelayOnce`）。
- 同じ forward 待受で通常モードの呼び出しはできない。両方が必要なら、通常モードと HGK 専用モードで待受を使い分ける設計が別に要る。この文書は、その設計を提供しない。

## 12. upstream への追従

### 12.1 リモートと基準

| remote | 向き先 |
| --- | --- |
| `origin` | `RaikiHiguchi/dsh-our-free-model`（このフォーク） |
| `upstream` | `Ebony-Vinyl/dsh-our-free-model`（元の開発元） |

作業の起点は `38648bf0ebecc63563e2e3324fbed4d323a442ac` である。version は上流と同じ `2.7.2` のまま変えていない。

### 12.2 フォークが上流と違う箇所

追従のとき、衝突しやすいのは次のファイルである。

| ファイル | 違い |
| --- | --- |
| [src/hgk.js](src/hgk.js) | 新規。上流には存在しない |
| [src/forward.js](src/forward.js) | `startForwardServer` に HGK 専用の分岐を追加 |
| [index.js](index.js) | `createHgkPlane` の取り込み、`syncForward`・`syncRelayOnce`・設定 API の変更 |
| [src/store.js](src/store.js) | `forward.hgkControlled` の初期値 |
| [package.json](package.json) | `files` に `src/hgk.js` を追加 |
| [scripts/test-all.mjs](scripts/test-all.mjs) | `hgk` の suite を追加 |
| [hgk-test.mjs](<scripts/hgk-test.mjs>) | 新規。HGK の非通信試験 |
| [subscription-completion.js](<src/subscription-completion.js>) | 既存の分割 stream 秘密除去関数を export し再利用。既存処理は変更しない |

### 12.3 追従の手順（書き方の例）

次は実行していない例である。取り込む前に、差分を読んでから進めること。

```powershell
git fetch upstream
git log --oneline HEAD..upstream/main      # 取り込む変更を読む
git diff HEAD upstream/main -- src/forward.js index.js src/store.js package.json scripts/test-all.mjs
# 衝突がなければ merge、衝突が多ければ rebase。方針は変更量を見て決める。
```

取り込んだ後は、`startForwardServer` の引数と `syncForward` の構造が変わっていないか、HGK の分岐が通常モードの前に残っているかを読んで確かめる。上流の変更が §8 の「経路を一つに固定する仕組み」に触れる場合（`FreeModelAdapter`・`createForwardCompletion`・`modelAvailability` など）は、`src/hgk.js` が呼ぶ内部関数の署名が変わっていないかを先に見る。

### 12.4 上流の自動更新が、フォークの差分を消す

既定の配布モード `distribution: 'self'` では、プラグインのアプリ内更新機能が `Ebony-Vinyl/dsh-our-free-model` の `main` から取得して、導入済みのファイルを置き換える（[src/updater.js](src/updater.js) の `REPO`）。この更新が走ると、HGK 専用の差分は上流の版で上書きされて消える。

これを避けるには、配布モードを `managed` にして、アプリ内更新・告知・ホットリロードを止める。`managed` は、プラグイン導入側（パッケージ管理者）が束縛設定（bundle patch）に書く値である。設定 API は `distribution` を受け付けないので、一度 `managed` で導入した環境は `managed` のまま保たれる（[index.js](index.js) の `distributionOf`）。

[cordis.patch.yml](cordis.patch.yml) に入れる場合の将来の書き方の例は次のとおり。**この文書は設定しない。** 導入側が、このフォークを自分で管理する判断をしたときの参考である。

```yaml
- insert:
    - id: our-free-model
      name: 'dsh-our-free-model'
      config:
        distribution: managed
```

`managed` にすると、フォークの更新は導入側の手作業になる。上流の修正（探測、catalog、不具合修正）が自動では届かなくなる点も、あわせて引き受ける必要がある。この判断は利用者が下す。

## 13. ライセンスと表示

このリポジトリは MIT License で、[LICENSE](LICENSE) をそのまま保持する。`vendor/` 以下に置かれた第三者のライセンスと `NOTICE.md`（`vendor/channel-pack/`、`vendor/magpie/`）も変更せず、配布物に含める。

HGK 専用モードの追加は、権限の管理・一回限りの能力・親による受入を作らない。それらは HGK 側の責務であり、このプラグインは判断しない。

## 14. 未確認の一覧

次は、この文書が確認していない点である。HGK がそれぞれを前提にするなら、別に確かめること。

- 型検査、依存不足で動かなかった試験と、一括回帰の不合格項目（§10）。
- Kilo の非 auto 経路の補完全体と、実環境の通信設定による影響。固定宛先の確認はプラグインが指定する URL までであり、宿主の global dispatcher などは対象外。
- 解決された宛先 gateway より先の、provider 内部の経路選択（§8.2）。
- `dataUse`・`training`・`retention`・`charge`・`quota` の実際の値（§5.3）。
- 設定 API を呼ぶ DSH 側のアドレスと認証（§3.1）。
- 署名付きリリースの作成・検証は未成立（§10）。
- 実環境の HGK 接続と親による出力受入。今回の非通信 fixture は、実 provider の可用性や出力の正しさを保証しない。

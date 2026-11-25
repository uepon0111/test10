# プロセカ譜面ビューア v2 — 設計書

元の `index.orig.html`（単一ファイルの Canvas2D プレイヤー）を温存し、**ゲームプレイヤー部分だけ**を
WASM + WebGL2 の新エンジンに置き換えた。曲一覧・SUS 取得・SVG 譜面表示・キャッシュ・設定画面は元のまま。

## ファイル構成

```
index.html            元アプリ。openPlayer だけ player.html 方式に置換（playerMain は削除）
player.html           プレイヤーページ（iframe で読み込み）。DOM は操作パネルと HUD だけ
js/
  wasm-loader.js      Rust WASM の読み込み + 同一 API の JS フォールバックカーネル
  gl-renderer.js      WebGL2 レンダラー（単一シェーダ、バケット描画、透視補正）
  fx.js               MikuMikuWorld 由来パーティクルシステム（プール + fx_*.json）
  engine.js           Engine + DrawData 事前計算 + TempoMap/ScrollLayer + 音声
  flat-view.js        SVG フラットビュー（元の drawFlat を DrawData 駆動に移植）
  stepper.js          スライダ下の ± ボタン（元アプリから verbatim）
wasm/proseka-core/    Rust コア（libm のみ、wasm-bindgen 不使用）。wasm/build.sh でビルド
assets/               素材（ASCII 名に正規化）+ notes_*.json アトラス座標 + effects/{0,1}/fx_*.json
tests/                Node テスト 4 本 + run_all.js + harness.html（ブラウザ smoke 用）
```

## A. 描画エンジン

- **WASM コア**（`wasm/proseka-core/src/lib.rs`、約 31KB）: 投影 `pj_batch`、小節↔秒 `bar/sec_to_bar_batch`、
  スクロール `scroll_batch`、スライドイージング `slide_ease_batch`、パーティクル `particle_step`、`rand_hash`。
  依存は libm のみ。`wasm-loader.js` が同一 API の JS カーネルを持ち、WASM が読めない環境（file:// 等）では
  自動でそちらに落ちる（`core.isWasm` で判別可能）。
- **WebGL2 レンダラー**（`gl-renderer.js`）: 頂点 9 float（NDC xy, uv, recipW, tint RGBA）。
  テクスチャ×ブレンドでバケット化し、1 フレーム約 5〜7 ドローコール。描画順は
  bg → stage → overlay → guide → bandBase → band → solid → notes →（加算）effect → glow。
- **透視補正**: クアッドの各頂点に `recipW = s = exp(-KAP·z)` を持たせ、頂点シェーダで
  `gl_Position = vec4(aPos * (1/aRecipW), 0, 1/aRecipW)` とすることで、GPU の透視補正補間を利用する。
  手動の vUv/vW 分割はしない。`zOf(f) = -ln(SF + f(1-SF))/KAP`、`SF = exp(-KAP·ZF)`。
- **幾何**（原典の実機計測値をそのまま使用）: GAR=1920/1342、消失点 yV=画面高 5.74%、判定線 yJ=73.47%、
  1マス幅 LU=画面幅 6.58%、KAP=45·ln(1.06)、ZF=0.978、JY=480、LW=20、LEAD=1.6。
  目標解像度は 1920×1080、ステージ画像は 2048×1176（`assets/stage.png`）。
- **UV の規約**（見直しで修正したバグ）: テクスチャは `UNPACK_FLIP_Y_WEBGL=false` で上げ、GL の v は画像の上からの割合。
  `quad()` の引数 `uv=[u0,v0,u1,v1]` は画像座標（y 下向き）。`spriteUV()` も同じ画像座標を返す。
  以前は両方に `1-v` の反転が入って二重に反転し、ステージ画像が上下逆に表示されていた。
- **DOM の分離**: ゲーム画面は `#gview` キャンバス 1 枚に集約（旧 `#gbg` は廃止）。DOM はヘッダー・設定パネル・
  フッター（シークバー等）の操作系だけ。フラット表示は SVG の `#stage`（V キーで切替）。

## B. 事前計算とデータ構造

- **DrawData**（`engine.js: buildDrawData`）: 読み込み時に以下をすべて計算する。
  ノーツの sec 時刻とスクロール q（テンポマップ＋ハイスピードを畳み込み済み）、レイヤー別 q ソート済みインデックス、
  スライド区間の分割済みセグメント・中継点・ホールド刻み（1/8 小節）、同時押しペア、小節線、ヒットイベント、曲の長さ。
  フレーム中は「見える q 窓の二分探索と描画」だけを行う。
- **visualTime**: `TempoMap`（小節↔秒）と `ScrollLayer`（TIL の速度積分）が、読み込み時に時刻変換へ畳み込む。
  SUS 変換は `index.html` の `parseSUS`/`buildPlay` をそのまま使い、D を `player.html` へ postMessage で渡す。
- **Engine/UI 境界**: `Engine` が現在時刻・曲の長さ・譜面終端・開始遅延を一元管理し、UI は `getState()` の値だけを使う。
  プレイヤーは独立ページ `player.html`（`playerMain` の `document.write` 直書きは削除）。
  親子間の受け渡しは `proseka-ready` / `proseka-play` の postMessage。旧 `window.__pl` API は互換維持
  （`setPlay/seek/setView/t/playing/dur/pps/JY`）。
- **再描画の規約**: 停止中は rAF ループが止まるため、`seek`/`setSettings`/`setSkin`/`setFxVariant` は
  `requestDraw()` で即座に 1 フレーム描く（見直しで修正したバグ。以前はシーク後に古いフレームが残った）。

## C. 素材（アセット）

- **アトラス**（`tools/make_atlas.py`）: `ノーツ.png`（1644×1472）を連結成分で抽出し、対称性（左右反転重なり ≥0.98=縦、
  未満=斜め）＋彩度画素の平均色相＋幅ランクで自動分類。スキンあたり 36 スプライト
  （シェブロン 24 = 縦/斜め×ピンク/黄×幅 6 段、ノーツ本体 7、宝石 5）。矩形の重なりなしをテストで検証。
  命名: `body_{tap,crit,flick,long}_{head,small}`、`gem_{long,crit,flick}_{l,s}`、`flick_{up,diag}_{crit,flick}_{1..6}`。
  宝石は種類によって large が無いものがある（flick は `_s` のみ）。`_emitGem` は `_l` → 同種 `_s` → `gem_long_l` の順にフォールバックする。
- **帯・ガイド**: ロング帯は `long_band_0{1,2}.png`（306×16、縦グラデーション）。
  描き方はベース単色クアッド（BODY 色 ×0.85·sl）＋帯テクスチャのシーンクアッド（α=0.5·sl、v は区間全体の長さ方向に流す）。
  ガイドは `guide_0{1,2}.png`＋頂点 α グラデーション（奥 0 → 手前 gd·K）。
- **背景**: ステージ `stage.png`（2048×1176）＋背景オーバーレイ `bg_overlay.png`（2048×2048）。
  背景の明るさ（10〜150%）とステージカバー不透明度（0〜100%）を設定可能。明るさは bg/stage/overlay バケットのみに適用。
- **スキン切替**: `notes_01` / `notes_02` を設定で切替。テクスチャ再読込時は旧テクスチャを削除する。

## D. エフェクト

- **パーティクルシステム**（`js/fx.js`）: Unity ParticleSystem 書き出し（root＋children）をランタイム定義に変換。
  曲線・グラデーションは 64 点 LUT 化。def 単位のバケットプール（上限 256/def）、発生・寿命・透明度を物理更新
  （重力は画面下向き +9.81×gravityModifier）。emit は def.order 昇順（lane=1 を note=50+ より先）。
- **定義ファイル**: `assets/effects/{0,1}/fx_*.json` 各 25 ファイル。`HIT_MAP`（tap/tap_crit/flick/flick_crit/long/long_crit/
  long_hold/trace 系）と `LANE_MAP`（lane flash 3 種）で通常/クリティカル/フリック/ロング/トレース別に記述。
  パターン 0/1 の差は主に startColor の α と randomSeed/children。
- **較正**: 1 Unity unit = 0.42 LU（`FX_UNIT_LU`）。gen グロー（startSize 2.688）が約 1.1 マス幅になる値。
  velocity/force over lifetime の LUT は Unity 単位/秒なので、位置・速度への加算時に `FX_UNIT_LU` を掛ける
  （見直しで修正したバグ。以前は px 換算なしで加算していた）。
  コンテナ専用エミッタ（life 0・バーストなし）は children を発火させるための不可視プレースホルダを 1 個だけ生成する
  （size 0 / alpha 0 を明示。以前はタイルの α に依存していた）。
- **粒の絵**: `effect.png`（1024×1024）から textureSheetAnimation のタイルを切り出す。
  frame = round(startFrame × tilesX × tilesY)（startFrame は正規化済み。全 50 ファイルで整数・範囲内をテストで検証）。
  lane 系は startSize.y=50〜70 の縦長ビーム（renderer mode 2、lengthScale で Y 方向に伸ばす）。

## E. 音声と同期

- **遅延補正の意味論**（重要）: `manualMs` / `ao` は音源の開始オフセット側で効かせる（原典 `ao` と同じ。＋で音が早く）。
  音声クロック `audioNow()` はデバイス遅延（`ctx.outputLatency` ＋ `getOutputTimestamp` の追加分）だけを差し引く。
  manualMs をクロック側に入れると二重補正になるため入れない。
- **自動計測**（`measureLatency()`）: `outputLatency` / `baseLatency` / `getOutputTimestamp` を読み、
  クロックが既に差し引いている分を超える追加遅延（Bluetooth 等）を `autoMs` として保存・適用する。
- **タップ調整**（`startTapTest()`）: クリックへの同調タップ。最初の 2 タップは慣らしとして除外し、残りの中央値から
  推奨 manualMs = −中央値 を提示して反映する。
- **書き出し用音声の分離**（`exportWav(rate)`）: 再生バッファとは別の stretch コピーから 16bit PCM WAV を生成する。
  再生中の速度とは独立に、指定した速度（0.5×/等速/2×）で書き出せる。WSOLA stretch は原典から移植。

## 検証

- `node tests/run_all.js`: 4 ファイル全パス。
  - test_kernel: WASM と JS カーネルの一致（pj/bar↔sec/scroll/slide_ease/particle/rand_hash）。
    WASM はローカル HTTP 経由の実 fetch で読み込む。
  - test_drawdata: 手作り D での q・同時押し・ホールド刻み（1/8 小節）・小節線・ヒットイベント・duration。
  - test_fx: 全 50 fx ファイルの変換、tile frame の整数・範囲内、HIT_MAP/LANE_MAP の解決。
  - test_atlas: スプライト名・矩形の範囲内・重なりなし。
- ブラウザ smoke（Chromium Headless Shell + Playwright、SwiftShader WebGL2）:
  `tests/harness.html` がデモ SUS（8 小節、タップ/フリック/スライド/中継点）を `player.html?demo` で再生。
  確認済み: WASM ロード、WebGL2 描画、ステージ・ノーツ・スライド帯・ヒット FX（15 バケット）・フラット表示・
  スキン切替、JS エラーなし。スクリーンショットは `/tmp/smoke/` 参照。
- 未検証: 実機ブラウザでの描画・音声（この環境はヘッドレスのみ）、実曲（sekai.best / master-db）での再生、
  Bluetooth 環境での遅延自動計測の実測値。ネットワーク取得が必要な音源・楽曲データはサンドボックスでは取得できない。

## 見直しで修正したバグ

1. UV の上下反転（`gl-renderer.js`）: `spriteUV` と `quad()` の二重の `1-v` 反転で、ステージ画像を含む全テクスチャが
   上下逆に表示されていた。画像座標（y 下向き）に統一して修正。
2. 停止中のシーク/設定変更で画面が更新されない（`engine.js`）: `seek`/`setSettings`/`setSkin`/`setFxVariant` が
   `_needDraw` だけ立てて描画しなかった。`requestDraw()` を呼ぶように修正。
3. フリック矢印の透視補正が常に 1 になっていた（`engine.js`）: `ar.nt._z` は存在しないプロパティで常に偽だった。
   `Math.exp(-KAP * ar.z)` を直接使うよう修正。
4. velocity/force over lifetime の単位換算漏れ（`fx.js`）: Unity 単位を px に換算せず加算していた。`FX_UNIT_LU` を掛けるよう修正。
5. 宝石フォールバック（`engine.js`）: `gem_flick_l` が存在しないため常に `gem_long_l` になっていた。同種 `_s` を優先するように修正。
6. コンテナ専用エミッタの不可視化（`fx.js`）: プレースホルダ粒子を size 0 / alpha 0 で明示するように修正。
7. `loadChart` の引数順（`player.html`）: `(S, D)` のところを `(D, null)` と呼んでいた。修正。
8. HUD の状態フィールド名（`player.html`）: `getState()` は `speed` / `fps` / `quads` / `drawCalls` を返す。`hsSpeed` 等の誤った参照を修正。
9. デモ SUS のレーン番号（`player.html`）: SUS のレーンは 2〜13（0/1 は対象外として捨てられる）。修正。

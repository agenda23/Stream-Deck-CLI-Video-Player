# Stream Deck CLI Video Player

Elgato Stream Deck MK.2 (5x3 keys) を 360x216 の単一キャンバスとして扱い、動画を再生する CLI ツールです。  
現場運用で迷わないよう、起動前・実行中・障害対応のチェックリスト形式でまとめています。

## 1分クイックスタート

```bash
npm install
node src/index.js --path "badapple.mp4" --fps 10 --brightness 70 --pixel-format bgr
```

表示されない場合は、`--pixel-format rgb` を試してください。

## 前提環境

- Node.js `20.x`（22以上は非推奨、実装側で停止）
- FFmpeg が `PATH` にある
- Elgato Stream Deck MK.2
- Windows ネイティブ実行を推奨（WSL 実機出力は非推奨）

## 現場向けチェックリスト

### 起動前チェック

- [ ] `node -v` が `20.x` である
- [ ] `ffmpeg -version` が実行できる
- [ ] Stream Deck が接続されている
- [ ] （Windows）`StreamDeck.exe` / `StreamDeckUI.exe` を停止済み
- [ ] 動画ファイルパスが存在する

占有停止コマンド（Windows）:

```powershell
taskkill /IM StreamDeck.exe /F
taskkill /IM StreamDeckUI.exe /F
```

### 起動直後チェック（ログ）

- [ ] `[decode] frames ready: 1` が出る
- [ ] `[render] start frame: 1` が出る
- [ ] `[render] frames sent: 1` 以降が増える

### 再生中チェック

- [ ] `decode` と `render` が継続的に増加
- [ ] デバイス表示が更新される
- [ ] フリーズしない

### 終了時チェック

- [ ] `Playback finished` が出る
- [ ] `[process] exit code: 0` が出る
- [ ] デバイスが解放される

## 実行コマンド集

### 通常再生

```bash
node src/index.js --path "badapple.mp4" --fps 10 --brightness 70 --pixel-format bgr
```

### 表示不良時の切替

```bash
node src/index.js --path "badapple.mp4" --fps 10 --brightness 70 --pixel-format rgb
```

### 負荷を下げる

```bash
node src/index.js --path "badapple.mp4" --fps 7 --brightness 70 --pixel-format bgr
```

### パイプラインのみ検証（デバイス送信なし）

```bash
node src/index.js --path "badapple.mp4" --fps 10 --brightness 70 --dry-run
```

## CLI オプション

- `--path`, `-p` (必須): 動画ファイルパス
- `--fps`, `-f` (既定: `10`): 描画 FPS
- `--brightness`, `-b` (既定: `70`): デバイス輝度（0-100）
- `--pixel-format` (既定: `rgb`): `rgb` または `bgr`
- `--dry-run` (既定: `false`): デバイス送信せずデコードのみ実施
- `--allow-wsl-hid` (既定: `false`): WSL で HID を強制許可（クラッシュリスクあり）

## 障害対応プレイブック

### ケースA: `Unable to open Stream Deck: cannot open device ...`

- デバイス占有の停止
- 接続状態確認（抜き差し）
- Linux の場合は `/dev/hidraw*` 権限/udev ルール確認

### ケースB: `decode` は増えるが表示されない

- `--pixel-format bgr` と `rgb` を切替
- `--fps 7` に下げる
- 公式アプリ完全停止を再確認

### ケースC: WSL でセグフォ

- 実機再生は Windows ネイティブに切替
- WSL では `--dry-run` のみ推奨

## 実装上の安定化ポイント（今回の対応）

- `@elgato-stream-deck/node` は v6 系を採用（Windows 安定性優先）
- MJPEG 抽出は `SOI(FFD8) -> EOI(FFD9)` ペアで実装
- `fillPanelBuffer` を使い、フレーム送信を1回に集約
- FFmpeg に `-re` を付け、実時間再生に近づけた
- FFmpeg 終了後も描画キューを排出してから終了
- `uncaughtException` / `unhandledRejection` / `exit` をログ化

## Git リポジトリ運用メモ

- `node_modules` やログ、core dump は `.gitignore` で除外
- Node バージョン固定は `.nvmrc` で共有
- 依存更新後は `npm install` で `package-lock.json` を同期

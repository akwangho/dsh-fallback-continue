# dsh-fallback-continue

當對話因紅字「本輪運行失敗」(turn error) 而終止時，這個外掛會自動替**那個會話**送出「繼續」，在無人值守下努力完成目標。

## 行為模型（無人值守，努力完成目標）

- 一個 turn 以 `error`（紅字「本輪運行失敗」）結束時，開始／延續一段「失敗連續」。
- 排一個倒數；倒數歸零時送出設定文字（預設「繼續」）**一次，然後停止計時**——改為等待大模型的下一輪結果。
- 若下一輪**又**失敗，連續失敗數 +1，按列表**遞增**重試間隔（`5 → 10 → 15 → 30 → 60 → 60 → 60 → 60`，之後固定 60 分鐘），重新排一個倒數。
- 中間若有成功看到 LLM 輸出（turn 以 `completed` 或 `max-tokens` 正常結束，即模型有產出），**整段失敗連續重置回最開始**（下次失敗從 5 分鐘重新起算）。

所以它不是「無腦無限重試」，而是：失敗→送一次→等下一輪；連續失敗才逐步拉長間隔；一旦成功就歸零。

## 觸發與停止

- **觸發**：簡中／繁中／英文介面的紅字都一樣，因為判斷依據是 Host 的 `turn/end` 事件（`error` 觸發；`completed` / `max-tokens` 視為成功重置），而非前端字串。
- **停止**：你手動送出任何訊息、重試成功（重置）、按取消／✕、會話被 archive、超過上限時數（預設 24h，`0`＝無上限）、或外掛被關閉。

## 可設定項目

| 項目 | 說明 | 預設 |
| --- | --- | --- |
| 啟用 | 總開關 | 關 |
| 自動送出的文字 | 每次送給大模型的文字 | 繼續 |
| 重試間隔（分鐘） | 逗號分隔，用完重複最後一個 | `5,10,15,30,60,60,60,60` |
| 超過上限自動停止 | 啟用 24h 這類上限 | 開 |
| 上限時數 | 從最近一次失敗連續起算，`0`＝無上限 | 24 |

## UI

- **右下角浮動條**（只看當前會話）：倒數中顯示 `⏳ 4:59 後自動繼續「繼續」(#2)`，每秒更新；點文字＝暫停／繼續，點 ✕＝取消。送出後顯示 `已送出「繼續」，等待結果`（不再計時）。
- **設定頁「失敗自動繼續」**：總開關、自動文字、間隔、上限設定，以及完整等待清單（每條的倒數／狀態、第幾次、失敗原因、暫停／立即重試／取消）。卡片底部顯示版本號。

## 安裝（本地 DSH web）

本外掛是標準 DSH web 外掛（npm package）：

```sh
# 安裝到本機的 web profile（會進 node_modules）
dsh plugin --profile web add github:akwangho/dsh-fallback-continue
```

然後在你的 `$DSH_HOME/profiles/web/cordis.patch.yml` 加上：

```yaml
- insert:
    - id: fallback-continue
      name: 'dsh-plugin-fallback-continue'
```

最後重啟 `dsh web` 生效。（若只是本機目錄測試，也可直接複製 `lib/` 與 `package.json` 到 `node_modules/dsh-plugin-fallback-continue/`。）

## 檔案結構

- `package.json` — npm package（含 `dsh.client` metadata）。
- `lib/index.js` — Host 半部（失敗偵測、遞增間隔、送「繼續」、停止條件、Typert `fallbackContinue` Remote 服務）。
- `lib/client.js` — Client 半部（右下角倒數、設定卡、等待清單）。
- `src/host.js` / `src/client.js` — 等價的「動態 Cordis」版（給 session 內 `cordis_define` 用，僅供參考）。
- `config.json` — 名稱、版本與預設值。

## 注意事項

- 重啟 DSH 程序後，等待中的倒數會重來（狀態只在記憶體，不跨程序留存）。
- 有些失敗是確定性的（例如模型不支援那麼大的 token 數），重試永遠不會成功——這種請手動處理（換模型或調參數），不要等自動繼續。
- 更新程式後需重啟 `dsh web` 才會生效。
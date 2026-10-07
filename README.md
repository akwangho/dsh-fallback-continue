# dsh-fallback-continue

當對話因紅字「本輪運行失敗」(turn error) 而終止時，這個外掛會自動替**那個會話**送出「繼續」，在無人值守下努力完成目標。

## 行為模型（無人值守，努力完成目標）

- 一個 turn 以 `error`（紅字「本輪運行失敗」）或以 `max-tokens`（橘字「已达到输出 token 上限／回答被截断」，回答被截斷）結束時，開始／延續一段「失敗連續」。
- 排一個倒數；倒數歸零時送出設定文字（預設「繼續」）**一次，然後停止計時**——改為等待大模型的下一輪結果。
- **排隊提示詞保留＋插隊後歸位**：失敗發生時**已經排在 inbox 裡**的提示詞（在失敗的 turn 之前就輸入、排在它後面的工作）會先被**保留**（從 agent 的 inbox 暫時移出），不會在「繼續」之前搶先開跑。**「繼續」一插隊送出（steering 進 next-step），這些提示詞就立刻按原本順序（FIFO）放回 next-turn 排隊**——driver 領取時一定先取完 next-step 的「繼續」再取 next-turn，所以「繼續」保證先執行、排隊任務緊接在後依序恢復，不會消失。保留時先掃 next-step 再掃 next-turn，使歸位順序與 driver 的領取優先序一致。取消、使用者接管、關閉外掛等其他停止方式也會把保留的提示詞放回，不會遺失；唯有 archive 會連同排隊訊息一起取消。
- **使用者即時接管**：循環進行中（倒數或已送出「繼續」，含已暫停）**新輸入**的訊息一律視為明確接管——立即停止循環、放行所有保留中的提示詞，你剛輸入的訊息馬上被執行（絕不會被默默吞掉：對話記錄只有在被 driver 領取後才會出現，所以保留機制絕不攔截新輸入的使用者訊息）。
- 若下一輪**又**失敗，連續失敗數 +1，按列表**遞增**重試間隔（`5 → 10 → 15 → 30 → 60 → 60 → 60 → 60`，之後固定 60 分鐘），重新排一個倒數；倒數期間排隊任務會**再次被保留**，等到下一次「繼續」插隊送出時又立即歸位（每個重試循環都如此）。
- 中間若有成功（turn 以 `completed` 結束），**整段失敗連續重置回最開始**（下次失敗從 5 分鐘重新起算）。

所以它不是「無腦無限重試」，而是：失敗→送一次→等下一輪；連續失敗才逐步拉長間隔；一旦成功就歸零。

## 觸發與停止

- **觸發**：簡中／繁中／英文介面的紅字都一樣，因為判斷依據是 Host 的 `turn/end` 事件與 `agent/error` 事件（以 turn 編號去重），而非前端字串。
- **停止**：你手動送出任何訊息（即時接管）、重試成功（重置）、turn 被中止（`aborted`，例如你按下停止鍵）、按取消／✕、會話被 **archive**、超過上限時數（預設 24h，`0`＝無上限）、或外掛被關閉。
- **受阻重排（`blocked`）**：若「繼續」在 pre-step 階段被其他外掛拒絕（例如子代理數量上限、RPM 限制的 reject 模式），該次輸入會被丟棄、turn 以 `blocked` 結束——此時**視同失敗重新倒數**（照遞增間隔再送一次），不會讓循環卡死在等待中。
- **上限停止記錄**：超過上限停止時，會在該會話的對話記錄中寫入一則通知訊息（⛔ 自動繼續已停止…），讓使用者能看到無人值守循環為何完全停止。
- **429 限流冷卻**：若最後一次失敗是 API 429（Rate Limit，`code === RATE_LIMIT` 或 HTTP 429），**不停止**，改為固定間隔（`cooldownMinutes`，預設 720 分鐘，可在 UI 設定）送出「繼續」以冷卻；連續 429 維持此間隔，回復正常後自動切回原遞增間隔。進入冷卻時在會話寫入通知（含本次 429 **發生時間**與**預計下次送出時間**）。冷卻期間排隊提示詞同樣被保留。
- **空轉防護**：保留提示詞期間，driver 偶爾會關閉一個沒有內容的 completed 邊界 turn（排程收斂的副產物）。這種 turn 不算成功——不會重置連續失敗、也不會提前放行保留中的提示詞；只有真正有輸入／輸出的完成才會放行。
- **持久化**：設定是**一般的 DSH volatile Config**（見下方「設定如何儲存」），重啟 `dsh web` 後仍保留。
- **保留提示詞的持久性限制**：保留中的提示詞放在外掛的記憶體佇列裡，但保留時間很短——只在「失敗倒數中」到「『繼續』插隊送出」之間；送出後立即歸位，等待中的每一輪也都會在送「繼續」時歸位。正常停止（成功、取消、接管、關閉外掛、`dsh web` 正常重啟）都會即時放回 inbox，不會遺失；僅**程序異常終止**（crash／強制 kill）且恰好在倒數期間，該輪保留佇列才無法回放。
- **多語 UI**：繁中／簡中／英文（透過 `locale` service）。

## 可設定項目

| 項目 | 說明 | 預設 |
| --- | --- | --- |
| 啟用 | 總開關 | 關 |
| 自動送出的文字 | 每次送給大模型的文字 | 繼續 |
| 重試間隔（分鐘） | 逗號分隔，用完重複最後一個 | `5,10,15,30,60,60,60,60` |
| 超過上限自動停止 | 啟用 24h 這類上限 | 開 |
| 上限時數 | 從最近一次失敗連續起算，`0`＝無上限 | 24 |
| 429 冷卻間隔（分鐘） | 遇到 429 後改用的固定重試間隔 | 720 |

## UI

- **右下角浮動條**（只看當前會話）：倒數中顯示 `⏳ 4:59 後自動繼續「繼續」(#2)`，每秒更新；點文字＝暫停／繼續，點 ✕＝取消。送出後顯示 `已送出「繼續」，等待結果`（不再計時）。
- **設定頁「失敗自動繼續」**：總開關、自動文字、間隔、上限設定，以及完整等待清單（每條的倒數／狀態、第幾次、失敗原因、保留中的排隊訊息數、暫停／立即重試／取消）。倒數中按鈕顯示「暫停」，點擊後狀態列顯示「已暫停」、按鈕變為「繼續」。卡片底部顯示版本號。
- **工作區會話清單**：進入等待的會話，其列尾會顯示橘色小圓徽章（倒數中 `⏳`、已送出 `✓`），懸停可看「正等待自動送出『繼續』(第幾次)」，不必切換進該會話就能看到它仍在無人值守運作。

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

## 設定如何儲存（volatile Config）

設定**不再**由外掛自建 namespace 存放，而是走 DSH 標準的 plugin Config 機制：

- `lib/config.js` 宣告 `Config`，六個欄位全部 `.volatile()`。volatile 有兩個關鍵效果：
  1. DSH 的 `settings` service **只**把 volatile 欄位投影成可編輯表單，所以設定頁才存得下。
  2. Loader 會把變更**寫進執行中的 reference**（`loader/volatile-update`）而**不重新掛載外掛**——所以你在設定頁改開關或間隔時，正在倒數的計時與保留中的提示詞都不會被清掉。
- 儲存位置就是 profile 的 `cordis.patch.yml`（DSH 自己寫回），不是外掛的檔案。
- Host 半部只**讀取** config，並在 `loader/volatile-update` 或 `settings/document-updated` 時重新讀取並套用到進行中的循環。瀏覽器半部透過 `ctx.configForms.get('fallback-continue')` 讀寫，跟第一方外掛（如 `dsh-client-ui-theme`）用的是同一套路徑。
- 外掛呼叫 `settings.configure({ auto: false }, ctx.fiber)`，告訴 DSH「這支外掛自帶設定頁」，避免 DSH 再自動產生一份重複表單。
- **namespace 必須等於 profile entry id**，也就是 `cordis.patch.yml` 裡的 `id: fallback-continue`。若你改了 id，設定頁會顯示紅色診斷而不是安靜地存不進去。
- 排程相關的設定（重試間隔、冷卻間隔、上限）一改，**已經在倒數的計時會立即改用新值**重新計算，不會繼續倒舊的數字。
- 啟用外掛**不會**回溯補送已經發生的失敗（那個 turn 早就結束了）；要在**下一次**失敗才開始循環。

## 檔案結構

- `package.json` — npm package（含 `dsh.client` metadata）與唯一版本號來源。
- `locale/en.json`、`locale/zh.json` — 外掛在「設定 → 外掛」清單中的顯示名稱與說明。
- `lib/index.js` — Host 半部（匯出 `Config`、Typert `fallbackContinue` Remote 服務與插件裝配）。
- `lib/config.js` — Config schema（volatile 欄位）與 settings namespace，無 Host 相依、可直接單元測試。
- `lib/controller.js` — 狀態機本體：失敗偵測、遞增間隔、排隊提示詞保留／放行、優先插隊送「繼續」、停止條件。
- `lib/pure.js` — 純函式（intervalFor/normalizeConfig/DEFAULTS/boundaryHasContent 等），無相依、可直接單元測試。
- `lib/client.js` — Client 半部（右下角倒數、設定卡、等待清單、自我診斷）。
- `test/host.test.mjs`、`test/controller.test.mjs`、`test/manifest.test.mjs`、`test/client.test.mjs` — 純函式、狀態機、Config schema、manifest 相容性與 Client 半部（浮動視窗）的單元測試（`npm test`）。

## DSH 版本相容性

DSH 在掛載 profile 外掛前會先做**相容性預檢**：讀取外掛 `package.json` 的 `peerDependencies`（不執行任何外掛程式碼），把名稱為 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 開頭的 peer 逐一與目前 DSH 版本比對。**只要有一個不符合，整個外掛就會被停用**，stderr 印一行然後外掛在 UI 上完全消失：

```text
dsh: disabling profile plugin row "fallback-continue": Plugin
dsh-plugin-fallback-continue@1.9.4 is incompatible with dsh 0.2.0-rc.2: peerDependencies {...}
```

這正是 1.9.x 在 DSH 從 0.1.x 升到 0.2.x 之後「看不見」的原因：peer 被寫成 `^0.1.0-rc.6`，而 0.x 的 caret 只允許同一個 minor。

因此本外掛的 `@deepseek-ai/dsh-*` peer 一律使用涵蓋整條 0.x 的明確範圍（`>=0.1.0-rc.6 <1.0.0`），不再使用 caret／tilde。`test/manifest.test.mjs` 會直接對 `package.json` 守住這條規則，確保下次 DSH 升級不會又無聲消失。

- 已驗證可載入的 DSH 版本：`0.1.0-rc.6`、`0.1.0-rc.8`、`0.2.0-rc.2`、`0.2.0`、`0.3.0-rc.1`、`0.9.9`。
- DSH `1.x` 刻意不相容：那時需要重新稽核 API，再依 audit 結果放寬。
- `@deepseek-ai/dsh-client-runtime` 在 0.2 已移除，已從 `dsh.client.inject` 移除。
- Client 的 sessions store 在 0.2 移除了 `SessionListState.current`：目前開啟的會話改由 `byId[*].retainedBy.mainView > 0` 判定（與內建 AppFrame／DocumentTitle 相同掃描）。浮動視窗先前讀 `s.current`，因此在 0.2 找不到當前會話而完全不顯示——只剩設定頁能暫停／取消。`test/client.test.mjs` 用 0.2 的 snapshot 形狀守住這條路徑。
- 這些 peer 在執行時都由 DSH host 提供，因此標記為 optional peer，`npm install` 不會把它們抓進本機 `node_modules`。
- 想略過預檢（不建議）：`dsh plugin allow-version` 為 `dsh-plugin-fallback-continue@<版本>` 開豁免。

## 自我診斷

外掛若載入失敗，**不會再無聲消失**：

- 設定頁頂端／底部會列出紅色診斷（缺少 `connection`／`slots`、RPC 連不到 host、slot 註冊失敗等）。
- 連設定頁都註冊不起來時，畫面左下角會出現一個固定的小紅框寫著第一條問題。
- 各個 UI 註冊彼此獨立：其中一項失敗不會連帶讓其他項消失。

## 注意事項

- 重啟 DSH 程序後，等待中的倒數會重來（狀態只在記憶體，不跨程序留存）。
- 「繼續」以 steering（插隊）方式送出：對閒置中的 agent 會直接開始新 turn。配合排隊提示詞保留，送出當下 inbox 已清空，所以「繼續」一定是 driver 下一個領取的輸入，用來先完成尚未完成的任務。
- 有些失敗是確定性的（例如模型不支援那麼大的 token 數），重試永遠不會成功——這種請手動處理（換模型或調參數），不要等自動繼續。
- 更新程式後需重啟 `dsh web` 才會生效。


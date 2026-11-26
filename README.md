# TripDock｜旅行資訊綜合管理系統

免安裝 Node.js、免編譯打包！解壓縮後直接上傳至 GitHub 並填寫 `js/config.js`，搭配免費免綁卡的 **Firebase Spark** 即可立刻上線使用。

## 檔案結構說明
- `index.html`、`manifest.json`、`firebase-messaging-sw.js`：前端主入口與 PWA 離線快取／推播設定
- `js/config.js`：**全站唯一需要修改的設定檔**（貼上 Firebase Web Config）
- `js/firebase.js`、`js/engines.js`、`js/app.js`：Firebase 連線、並行時間軸、尾數進位分帳與完整介面邏輯
- `docs/USER_GUIDE.md`：App 內 `[i]` 說明彈窗直接讀取的使用者說明書
- `icons/`：加入主畫面圖示（可直接替換為喜歡的正方形 PNG 圖檔）
- `cloud-setup/firestore.rules`：複製貼上至 Firebase Console → Firestore Database → 規則
- `cloud-setup/gas-Code.gs`：第二階段選用（FCM 排程推播與 Google Maps 餐廳營業時間自動帶入）

/**
 * TripDock 全系統唯一設定檔
 * 網頁前端與 firebase-messaging-sw.js 會共同讀取此檔。
 * 請將 Firebase Console → 專案設定 → 一般 → 您的應用程式 中的數值貼入下方。
 */
self.TRIPDOCK_CONFIG = {
  // === 1. Firebase Web App 設定（必填）===
  firebase: {
    apiKey: "AIzaSyADkCiyZy6YcUKuyP6njWXrkNgqbVUywUc",
    authDomain: "tripdock-a6bd2.firebaseapp.com",
    projectId: "tripdock-a6bd2",
    storageBucket: "tripdock-a6bd2.firebasestorage.app",
    messagingSenderId: "181629350989",
    appId: "1:181629350989:web:7eb23cf8b9edad65e85804"
  },

  // === 2. Web Push VAPID 金鑰（選填，開啟推播通知時需要）===
  // 位置：Firebase Console → 專案設定 → Cloud Messaging → 網路推播憑證
  vapidKey: "",

  // === 3. GAS 跳板 Web App 網址（第二階段功能：FCM 推播發送與 Google Maps 營業時間自動帶入）===
  // 留空時系統仍可完整運作，僅暫停自動推播與自動抓營業時間
  gasBridgeUrl: ""
};

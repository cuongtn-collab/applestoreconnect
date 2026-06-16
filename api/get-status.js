const jwt = require('jsonwebtoken');
const axios = require('axios');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { google } = require('googleapis');

// ==========================================
// THƯ VIỆN HÀM NHÀ MÁY (FACTORY FUNCTIONS)
// ==========================================

function createHeaderStyleRequest(sheetId, startRow, endRow, rgbBg) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: startRow, endRowIndex: endRow },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgbBg,
          textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 11 },
          horizontalAlignment: "CENTER",
          verticalAlignment: "MIDDLE"
        }
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)"
    }
  };
}

function createColorRuleRequest(sheetId, ranges, textToFind, rgbBg, rgbText, isBold = true) {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: ranges,
        booleanRule: {
          condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: textToFind }] },
          format: {
            backgroundColor: rgbBg,
            textFormat: { foregroundColor: rgbText, bold: isBold }
          }
        }
      },
      index: 0
    }
  };
}

// HÀM GỬI DISCORD 1 DÒNG SIÊU NGẮN
async function sendDiscordAlert(webhookUrl, accountName, appName, version, newStatus) {
  if (!webhookUrl || webhookUrl.includes("ĐIỀN_LINK_DISCORD")) return;

  let colorCode = "\u001b[1;30m"; 
  let icon = "⚪";

  if (newStatus.includes("READY") || newStatus.includes("APPROVED")) {
    colorCode = "\u001b[1;32m"; 
    icon = "🟢";
  } else if (newStatus.includes("REVIEW") || newStatus.includes("WAITING") || newStatus.includes("PROCESSING")) {
    colorCode = "\u001b[1;33m"; 
    icon = "🟡";
  } else if (newStatus.includes("REJECTED")) {
    colorCode = "\u001b[1;31m"; 
    icon = "🔴";
  }

  const ansiMessage = "```ansi\n" + `${icon} [${accountName}] ${appName} (v${version}) -> ${colorCode}${newStatus}\u001b[0m` + "\n```";

  try {
    await axios.post(webhookUrl, { content: ansiMessage });
  } catch (err) {
    console.error("Lỗi gửi Discord:", err.message);
  }
}

// ==========================================
// LUỒNG XỬ LÝ TRUNG TÂM (CORE HANDLER)
// ==========================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(500).json({ success: false, error: "Hệ thống thiếu cấu hình FIREBASE_SERVICE_ACCOUNT trên Vercel!" });
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    const db = getFirestore();
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const snapshot = await db.collection('apple_accounts').get();
    if (snapshot.empty) {
      return res.status(404).json({ success: false, error: "Không tìm thấy tài khoản Firebase" });
    }
    
    let accounts = [];
    snapshot.forEach(doc => accounts.push({ id: doc.id, ...doc.data() }));

    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    let existingTabs = sheetMeta.data.sheets.map(s => ({ title: s.properties.title, id: s.properties.sheetId }));

    const fetchSingleAccountData = async (account) => {
      if (!account.privateKey) {
        return { accountName: account.accountName, status: "Trống", t1: [], t2: [], m1: [], m2: [] };
      }

      const formattedKey = account.privateKey.replace(/\\n/g, '\n');
      const token = jwt.sign(
        { sub: "user", aud: "appstoreconnect-v1", exp: Math.floor(Date.now() / 1000) + 600 }, 
        formattedKey, 
        { algorithm: 'ES256', header: { alg: 'ES256', kid: account.keyId, typ: 'JWT' }}
      );

      try {
        const response = await axios.get('https://api.appstoreconnect.apple.com/v1/apps?include=appStoreVersions', { 
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const apps = response.data.data;
        const included = response.data.included || [];
        
        let table1Rows = [["Tên Game", "Phiên Bản", "Trạng Thái App", "Chiến Dịch PPO (A/B Test)", "Trạng Thái PPO", "Tỷ Lệ Traffic"]];
        let table2Rows = [["Tên Game", "Thời Gian Ghi Nhận (Mốc sự kiện)", "Trạng Thái Của Đợt Duyệt"]];
        
        let m1Config = [];
        let m2Config = [];

        for (const app of apps) {
          const appName = app.attributes.name;
          const cleanAppId = app.id;

          // --- XỬ LÝ BẢNG 1: QUÉT TRẠNG THÁI VÀ VIẾT NHẬT KÝ VÀO FIREBASE ---
          let t1Start = table1Rows.length;
          let appHasVersions = false;
          const versionLinks = app.relationships.appStoreVersions.data || [];

          for (const vLink of versionLinks) {
            const vInfo = included.find(item => item.id === vLink.id && item.type === 'appStoreVersions');
            if (vInfo) {
              appHasVersions = true;
              const currentVersion = vInfo.attributes.versionString;
              const currentStatus = vInfo.attributes.appStoreState;

              const appFirebaseRef = db.collection('app_status_cache').doc(`${account.id}_${cleanAppId}_${currentVersion}`);
              const cacheDoc = await appFirebaseRef.get();
              
              let statusHistory = [];

              if (cacheDoc.exists) {
                const data = cacheDoc.data();
                const oldStatus = data.lastKnownStatus;
                // Bốc lại toàn bộ mảng lịch sử cũ (nếu có)
                statusHistory = data.history || [];

                if (oldStatus !== currentStatus) {
                  await sendDiscordAlert(DISCORD_WEBHOOK_URL, account.accountName, appName, currentVersion, currentStatus);
                  
                  // Khắc thêm 1 dòng vào mảng lịch sử
                  statusHistory.push({ status: currentStatus, time: new Date().toISOString() });
                  await appFirebaseRef.update({ 
                    lastKnownStatus: currentStatus, 
                    history: statusHistory,
                    updatedAt: new Date() 
                  });
                }
              } else {
                // Lần đầu thấy App, khởi tạo sổ nhật ký
                statusHistory = [{ status: currentStatus, time: new Date().toISOString() }];
                await appFirebaseRef.set({ 
                  accountId: account.id, 
                  appName: appName, 
                  version: currentVersion, 
                  lastKnownStatus: currentStatus, 
                  history: statusHistory,
                  updatedAt: new Date() 
                });
              }

              let ppoCampaigns = [];
              try {
                const ppoRes = await axios.get(`https://api.appstoreconnect.apple.com/v1/appStoreVersions/${vLink.id}/appStoreVersionExperimentsV2`, { 
                  headers: { 'Authorization': `Bearer ${token}` } 
                });
                if (ppoRes.data.data) ppoCampaigns = ppoRes.data.data;
              } catch (e) {}

              if (ppoCampaigns.length > 0) {
                for (const ppo of ppoCampaigns) {
                  table1Rows.push([appName, currentVersion, currentStatus, ppo.attributes.name, ppo.attributes.state, ppo.attributes.trafficProportion ? `${ppo.attributes.trafficProportion}%` : "-"]);
                }
              } else {
                table1Rows.push([appName, currentVersion, currentStatus, "Không có", "-", "-"]);
              }
            }
          }
          if (!appHasVersions) table1Rows.push([appName, "-", "-", "-", "-", "-"]);
          let t1End = table1Rows.length;
          if (t1End > t1Start + 1) m1Config.push({ startRow: t1Start, endRow: t1End });

          // --- XỬ LÝ BẢNG 2: ĐỌC LỊCH SỬ TỪ FIREBASE ĐỔ RA GOOGLE SHEETS ---
          let t2Start = table2Rows.length;
          try {
            // Gom tất cả các phiên bản của game này trong Firebase
            const historyQuery = await db.collection('app_status_cache').where('accountId', '==', account.id).get();

            let allHistory = [];
            historyQuery.forEach(doc => {
              // Lọc chuẩn xác Game ID
              if (doc.id.includes(`_${cleanAppId}_`)) {
                const data = doc.data();
                let hist = data.history;
                
                // Mẹo nhỏ: Hỗ trợ data cũ chưa có mảng history của ngày hôm qua
                if (!hist && data.lastKnownStatus) {
                  let timeVal = new Date().toISOString();
                  if (data.updatedAt && typeof data.updatedAt.toDate === 'function') {
                    timeVal = data.updatedAt.toDate().toISOString();
                  }
                  hist = [{ status: data.lastKnownStatus, time: timeVal }];
                }

                if (hist) {
                  hist.forEach(item => {
                    allHistory.push({
                      version: data.version,
                      status: item.status,
                      time: new Date(item.time)
                    });
                  });
                }
              }
            });

            // Sắp xếp các sự kiện trên Firebase theo thời gian tăng dần
            allHistory.sort((a, b) => a.time - b.time);

            if (allHistory.length > 0) {
              allHistory.forEach(item => {
                const formattedDate = item.time.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
                table2Rows.push([appName, formattedDate, `[v${item.version}] ${item.status}`]);
              });
            } else {
              table2Rows.push([appName, "Bot đang bắt đầu ghi chép từ hôm nay...", "-"]);
            }
          } catch (e) {
            table2Rows.push([appName, "Đang khởi tạo bộ nhớ lịch sử...", "-"]);
          }
          
          let t2End = table2Rows.length;
          if (t2End > t2Start + 1) m2Config.push({ startRow: t2Start, endRow: t2End });
        }

        return { accountName: account.accountName, status: "Thành công", t1: table1Rows, t2: table2Rows, m1: m1Config, m2: m2Config };
      } catch (err) {
        return { accountName: account.accountName, status: "Lỗi", detail: err.message, t1: [], t2: [], m1: [], m2: [] };
      }
    };

    const results = await Promise.all(accounts.map(acc => fetchSingleAccountData(acc)));

    // ĐỔ DỮ LIỆU VÀ ĐÈ MỸ THUẬT GOOGLE SHEETS
    let sheetActionLogs = [];
    
    for (const resData of results) {
      const tabName = resData.accountName.substring(0, 30);
      if (resData.status !== "Thành công" || resData.t1.length === 0) {
        sheetActionLogs.push({ account: tabName, status: "Bỏ qua hoặc lỗi", detail: resData.detail || "Không có dữ liệu" });
        continue;
      }

      let currentSheetId;
      const foundTab = existingTabs.find(t => t.title === tabName);
      const foundTabInMeta = sheetMeta.data.sheets.find(s => s.properties.title === tabName);
      
      let deleteOldRulesRequests = [];

      if (!foundTab) {
        const newSheet = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: { requests: [{ addSheet: { properties: { title: tabName } } }] }
        });
        currentSheetId = newSheet.data.replies[0].addSheet.properties.sheetId;
        existingTabs.push({ title: tabName, id: currentSheetId });
      } else {
        currentSheetId = foundTab.id;
        if (foundTabInMeta && foundTabInMeta.conditionalFormats) {
          for (let k = 0; k < foundTabInMeta.conditionalFormats.length; k++) {
            deleteOldRulesRequests.push({ deleteConditionalFormatRule: { sheetId: currentSheetId, index: 0 } });
          }
        }
      }

      const table1Length = resData.t1.length;
      const bannerIndex = table1Length + 1;    
      const header2Index = table1Length + 2;   
      const table2BaseIndex = table1Length + 2; 

      const finalSheetRows = [
        ...resData.t1,
        ["", "", "", "", "", ""], 
        ["LỊCH SỬ CÁC ĐỢT GỬI DUYỆT CHI TIẾT (APP REVIEW TIMELINE)", "", "", "", "", ""],
        ...resData.t2
      ];

      await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A1:Z2000` });
      await sheets.spreadsheets.values.update({ 
        spreadsheetId: SPREADSHEET_ID, 
        range: `${tabName}!A1`, 
        valueInputOption: 'USER_ENTERED', 
        resource: { values: finalSheetRows } 
      });

      let mergeRequests1 = resData.m1.map(m => ({
        mergeCells: { range: { sheetId: currentSheetId, startRowIndex: m.startRow, endRowIndex: m.endRow, startColumnIndex: 0, endColumnIndex: 1 }, mergeType: "MERGE_ALL" }
      }));

      let mergeRequests2 = resData.m2.map(m => ({
        mergeCells: { range: { sheetId: currentSheetId, startRowIndex: m.startRow + table2BaseIndex, endRowIndex: m.endRow + table2BaseIndex, startColumnIndex: 0, endColumnIndex: 1 }, mergeType: "MERGE_ALL" }
      }));

      const targetRanges = [
        { sheetId: currentSheetId, startColumnIndex: 2, endColumnIndex: 5, startRowIndex: 1, endRowIndex: table1Length },
        { sheetId: currentSheetId, startColumnIndex: 2, endColumnIndex: 3, startRowIndex: table2BaseIndex + 1, endRowIndex: finalSheetRows.length }
      ];

      let decoratorRequests = [
        ...deleteOldRulesRequests,
        { unmergeCells: { range: { sheetId: currentSheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 7 } } },
        ...mergeRequests1,
        ...mergeRequests2,
        { mergeCells: { range: { sheetId: currentSheetId, startRowIndex: bannerIndex, endRowIndex: bannerIndex + 1, startColumnIndex: 0, endColumnIndex: 6 }, mergeType: "MERGE_ALL" } },
        
        createHeaderStyleRequest(currentSheetId, 0, 1, { red: 0.12, green: 0.3, blue: 0.47 }), 
        createHeaderStyleRequest(currentSheetId, bannerIndex, bannerIndex + 1, { red: 0.22, green: 0.29, blue: 0.36 }), 
        createHeaderStyleRequest(currentSheetId, header2Index, header2Index + 1, { red: 0.27, green: 0.44, blue: 0.53 }), 
        
        { repeatCell: { range: { sheetId: currentSheetId, startRowIndex: 1, endRowIndex: finalSheetRows.length }, cell: { userEnteredFormat: { verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(verticalAlignment)" } },
        { updateSheetProperties: { properties: { sheetId: currentSheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        { autoResizeDimensions: { dimensions: { sheetId: currentSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 7 } } },
        
        createColorRuleRequest(currentSheetId, targetRanges, "READY", { red: 0.85, green: 0.95, blue: 0.85 }, { red: 0.1, green: 0.4, blue: 0.1 }),
        createColorRuleRequest(currentSheetId, targetRanges, "APPROVED", { red: 0.85, green: 0.95, blue: 0.85 }, { red: 0.1, green: 0.4, blue: 0.1 }),
        createColorRuleRequest(currentSheetId, targetRanges, "REVIEW", { red: 1.0, green: 0.95, blue: 0.80 }, { red: 0.7, green: 0.4, blue: 0.0 }),
        createColorRuleRequest(currentSheetId, targetRanges, "WAITING", { red: 1.0, green: 0.95, blue: 0.80 }, { red: 0.7, green: 0.4, blue: 0.0 }),
        createColorRuleRequest(currentSheetId, targetRanges, "PROCESSING", { red: 1.0, green: 0.95, blue: 0.80 }, { red: 0.7, green: 0.4, blue: 0.0 }),
        createColorRuleRequest(currentSheetId, targetRanges, "REJECTED", { red: 0.98, green: 0.85, blue: 0.85 }, { red: 0.7, green: 0.1, blue: 0.1 }),
        createColorRuleRequest(currentSheetId, targetRanges, "PREPARE", { red: 0.92, green: 0.92, blue: 0.92 }, { red: 0.4, green: 0.4, blue: 0.4 }, false),
        createColorRuleRequest(currentSheetId, targetRanges, "REMOVED", { red: 0.85, green: 0.85, blue: 0.85 }, { red: 0.3, green: 0.3, blue: 0.3 }, false)
      ];

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: decoratorRequests }
      });

      sheetActionLogs.push({ account: tabName, status: "Thành công" });
    }

    return res.status(200).json({ success: true, message: "Hệ thống đã nâng cấp sổ nhật ký độc lập và đổ màu lên Google Sheets thành công!", report: sheetActionLogs });
  } catch (error) { 
    return res.status(500).json({ success: false, detail: error.message }); 
  }
};
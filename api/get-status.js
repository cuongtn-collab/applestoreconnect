const jwt = require('jsonwebtoken');
const axios = require('axios');

async function sendDiscordAlert(webhookUrl, alert) {
  if (!webhookUrl || webhookUrl.includes("ĐIỀN_LINK_DISCORD")) return;
  
  let colorCode = "\u001b[1;30m"; let icon = "⚪";
  const status = alert.status;

  if (status.includes("READY") || status.includes("APPROVED") || status.includes("COMPLETED")) { colorCode = "\u001b[1;32m"; icon = "🟢"; }
  else if (status.includes("REVIEW") || status.includes("WAITING") || status.includes("PROCESSING")) { colorCode = "\u001b[1;33m"; icon = "🟡"; }
  else if (status.includes("REJECTED") || status.includes("STOPPED")) { colorCode = "\u001b[1;31m"; icon = "🔴"; }

  let ansiMessage = "";

  if (alert.type === "APP") {
    ansiMessage = "```ansi\n" + 
      `${icon} [${alert.accountName}] ${alert.appName}\n` +
      `   🔹 Phiên bản : v${alert.version}\n` +
      `   🔹 Gói thầu   : ${alert.bundleId}\n` +
      `   🔹 Trạng thái : ${colorCode}${status}\u001b[0m\n` +
      "```";
  } else if (alert.type === "PPO") {
    ansiMessage = "```ansi\n" + 
      `${icon} [${alert.accountName}] ${alert.appName} (v${alert.version})\n` +
      `   📊 CHIẾN DỊCH PPO (A/B TEST)\n` +
      `   🔹 Tên PPO   : ${alert.ppoName}\n` +
      `   🔹 Traffic   : ${alert.traffic}\n` +
      `   🔹 Trạng thái : ${colorCode}${status}\u001b[0m\n` +
      "```";
  }
  
  try { await axios.post(webhookUrl, { content: ansiMessage }); } catch (err) {}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ success: false, error: "Thiếu cấu hình APPS_SCRIPT_URL!" });

    // 1. Lấy dữ liệu và bộ nhớ cũ
    const initRes = await axios.post(APPS_SCRIPT_URL, { action: "getData" });
    const accounts = initRes.data.accounts || [];
    const oldCacheMap = initRes.data.cache || {};

    if (accounts.length === 0) return res.status(200).json({ success: true, message: "Tab [Cấu Hình] trống!" });

    let dashboardData = [];
    let newCacheMap = {}; // Tạo bộ nhớ mới tinh để đối chiếu
    let hasChanges = false; // 🛡️ CHỐT CHẶN TRIỆT ĐỂ

    const fetchSingleAccountData = async (account) => {
      let rawKey = account.privateKey.trim();
      if (!rawKey.includes('\n') && rawKey.includes('-----BEGIN PRIVATE KEY-----')) rawKey = rawKey.replace(/\\n/g, '\n');
      if (!rawKey.includes('\n')) {
        const body = rawKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s+/g, '');
        rawKey = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
      }

      const token = jwt.sign(
        { sub: "user", aud: "appstoreconnect-v1", exp: Math.floor(Date.now() / 1000) + 600 }, 
        rawKey, { algorithm: 'ES256', header: { alg: 'ES256', kid: account.keyId, typ: 'JWT' }}
      );

      try {
        const response = await axios.get('https://api.appstoreconnect.apple.com/v1/apps?include=appStoreVersions', { headers: { 'Authorization': `Bearer ${token}` } });
        const apps = response.data.data;
        const included = response.data.included || [];

        for (const app of apps) {
          const appName = app.attributes.name;
          const bundleId = app.attributes.bundleId;
          const versionLinks = app.relationships.appStoreVersions.data || [];

          if (versionLinks.length === 0) {
            dashboardData.push([account.accountName, appName, "-", bundleId, "Chưa có bản build", "-", "-", "-"]);
            continue;
          }

          let vInfos = versionLinks.map(vLink => included.find(item => item.id === vLink.id && item.type === 'appStoreVersions')).filter(Boolean);
          vInfos.sort((a, b) => {
            const timeA = a.attributes.createdDate ? new Date(a.attributes.createdDate).getTime() : parseInt(a.id);
            const timeB = b.attributes.createdDate ? new Date(b.attributes.createdDate).getTime() : parseInt(b.id);
            return timeB - timeA;
          });
          const vInfo = vInfos[0]; 
          
          const safeVersion = vInfo.attributes.versionString;
          const currentStatus = vInfo.attributes.appStoreState;
          const appCacheKey = `APP_${account.accountName}_${bundleId}_${safeVersion}`;
          
          // Ghi vào bộ nhớ mới
          newCacheMap[appCacheKey] = currentStatus;

          // SO SÁNH: Nếu trạng thái khác với bộ nhớ cũ -> Có biến!
          if (oldCacheMap[appCacheKey] !== currentStatus) {
            hasChanges = true;
            if (currentStatus === "IN_REVIEW" || currentStatus === "REJECTED") {
              await sendDiscordAlert(DISCORD_WEBHOOK_URL, { type: "APP", accountName: account.accountName, appName, version: safeVersion, status: currentStatus, bundleId });
            }
          }

          let ppoCampaigns = [];
          try {
            const ppoRes = await axios.get(`https://api.appstoreconnect.apple.com/v1/appStoreVersions/${vInfo.id}/appStoreVersionExperimentsV2`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (ppoRes.data.data) ppoCampaigns = ppoRes.data.data;
          } catch (e) {}

          if (ppoCampaigns.length > 0) {
            for (const ppo of ppoCampaigns) {
              const ppoName = ppo.attributes.name;
              const ppoStatus = ppo.attributes.state;
              const ppoTraffic = ppo.attributes.trafficProportion ? `${ppo.attributes.trafficProportion}%` : "-";
              
              const ppoCacheKey = `PPO_${account.accountName}_${bundleId}_${safeVersion}_${ppoName}`;
              const combinedStatus = `${ppoStatus}_${ppoTraffic}`;
              
              newCacheMap[ppoCacheKey] = combinedStatus;

              if (oldCacheMap[ppoCacheKey] !== combinedStatus) {
                hasChanges = true;
                await sendDiscordAlert(DISCORD_WEBHOOK_URL, { type: "PPO", accountName: account.accountName, appName, version: safeVersion, status: ppoStatus, ppoName, traffic: ppoTraffic });
              }
              
              dashboardData.push([account.accountName, appName, `'${safeVersion}`, bundleId, currentStatus, ppoName, ppoStatus, ppoTraffic]);
            }
          } else {
            dashboardData.push([account.accountName, appName, `'${safeVersion}`, bundleId, currentStatus, "Không có", "-", "-"]);
          }
        }
      } catch (err) {
        console.error(`Lỗi quét ${account.accountName}:`, err.message);
      }
    };

    await Promise.all(accounts.map(acc => fetchSingleAccountData(acc)));

    dashboardData.sort((a, b) => {
      if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
      return a[1].localeCompare(b[1]);
    });

    // Bắt trường hợp có game mới thêm vào hoặc bị xóa đi
    if (Object.keys(oldCacheMap).length !== Object.keys(newCacheMap).length) {
      hasChanges = true;
    }

    // 2. CHỈ GỌI GOOGLE SHEETS IN LẠI NẾU THỰC SỰ CÓ THAY ĐỔI
    if (hasChanges) {
      const newCacheArr = Object.entries(newCacheMap);
      await axios.post(APPS_SCRIPT_URL, { action: "updateDashboard", newCache: newCacheArr, dashboardData: dashboardData });
      return res.status(200).json({ success: true, message: "Phát hiện thay đổi! Đã cập nhật lại Bảng Tổng Hợp." });
    } else {
      // NẾU KHÔNG CÓ GÌ THAY ĐỔI -> ĐI NGỦ 
      return res.status(200).json({ success: true, message: "Không có gì thay đổi. Giữ nguyên bảng hiện tại!" });
    }
    
  } catch (error) {
    return res.status(500).json({ success: false, detail: error.message });
  }
};
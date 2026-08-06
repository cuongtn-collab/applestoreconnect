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

    const initRes = await axios.post(APPS_SCRIPT_URL, { action: "getData" });
    const accounts = initRes.data.accounts || [];
    let cacheMap = initRes.data.cache || {};

    if (accounts.length === 0) return res.status(200).json({ success: true, message: "Tab [Cấu Hình] trống!" });

    let dashboardData = [];

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

          for (const vLink of versionLinks) {
            const vInfo = included.find(item => item.id === vLink.id && item.type === 'appStoreVersions');
            if (vInfo) {
              const safeVersion = vInfo.attributes.versionString;
              const currentStatus = vInfo.attributes.appStoreState;
              
              const appCacheKey = `APP_${account.accountName}_${bundleId}_${safeVersion}`;
              if (cacheMap[appCacheKey] !== currentStatus) {
                cacheMap[appCacheKey] = currentStatus;
                if (currentStatus === "IN_REVIEW" || currentStatus === "REJECTED") {
                  await sendDiscordAlert(DISCORD_WEBHOOK_URL, { type: "APP", accountName: account.accountName, appName, version: safeVersion, status: currentStatus, bundleId });
                }
              }

              let ppoCampaigns = [];
              try {
                const ppoRes = await axios.get(`https://api.appstoreconnect.apple.com/v1/appStoreVersions/${vLink.id}/appStoreVersionExperimentsV2`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (ppoRes.data.data) ppoCampaigns = ppoRes.data.data;
              } catch (e) {}

              if (ppoCampaigns.length > 0) {
                for (const ppo of ppoCampaigns) {
                  const ppoName = ppo.attributes.name;
                  const ppoStatus = ppo.attributes.state;
                  const ppoTraffic = ppo.attributes.trafficProportion ? `${ppo.attributes.trafficProportion}%` : "-";
                  
                  const ppoCacheKey = `PPO_${account.accountName}_${bundleId}_${safeVersion}_${ppoName}`;
                  const combinedStatus = `${ppoStatus}_${ppoTraffic}`;
                  
                  if (cacheMap[ppoCacheKey] !== combinedStatus) {
                    cacheMap[ppoCacheKey] = combinedStatus;
                    await sendDiscordAlert(DISCORD_WEBHOOK_URL, { type: "PPO", accountName: account.accountName, appName, version: safeVersion, status: ppoStatus, ppoName, traffic: ppoTraffic });
                  }
                  
                  // Đẩy data vào Bảng Tổng Hợp
                  dashboardData.push([account.accountName, appName, `'${safeVersion}`, bundleId, currentStatus, ppoName, ppoStatus, ppoTraffic]);
                }
              } else {
                // Đẩy data vào Bảng Tổng Hợp (Game không có PPO)
                dashboardData.push([account.accountName, appName, `'${safeVersion}`, bundleId, currentStatus, "Không có", "-", "-"]);
              }
            }
          }
        }
      } catch (err) {
        console.error(`Lỗi quét ${account.accountName}:`, err.message);
      }
    };

    await Promise.all(accounts.map(acc => fetchSingleAccountData(acc)));

    // Sắp xếp Bảng Tổng Hợp theo Tên Tài Khoản -> Tên Game cho đẹp mắt
    dashboardData.sort((a, b) => {
      if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
      return a[1].localeCompare(b[1]);
    });

    // 3. GỬI DATA VỀ GOOGLE SHEETS VẼ BẢNG (1 LỆNH DUY NHẤT - CỰC NHANH)
    const newCacheArr = Object.entries(cacheMap);
    await axios.post(APPS_SCRIPT_URL, { action: "updateDashboard", newCache: newCacheArr, dashboardData: dashboardData });

    return res.status(200).json({ success: true, message: "Quét thành công! Bảng Tổng Hợp đã được cập nhật siêu tốc!" });
  } catch (error) {
    return res.status(500).json({ success: false, detail: error.message });
  }
};
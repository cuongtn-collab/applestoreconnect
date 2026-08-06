const jwt = require('jsonwebtoken');
const axios = require('axios');

async function sendDiscordAlert(webhookUrl, alert) {
  if (!webhookUrl || webhookUrl.includes("ĐIỀN_LINK_DISCORD")) return;
  
  let colorCode = alert.status.includes("REJECTED") ? "\u001b[1;31m" : "\u001b[1;33m"; 
  let icon = alert.status.includes("REJECTED") ? "🔴" : "🟡";

  let ansiMessage = alert.type === "APP" 
    ? "```ansi\n" + `${icon} [${alert.accountName}] ${alert.appName}\n   🔹 Phiên bản : v${alert.version}\n   🔹 Gói thầu   : ${alert.bundleId}\n   🔹 Trạng thái : ${colorCode}${alert.status}\u001b[0m\n` + "```"
    : "```ansi\n" + `${icon} [${alert.accountName}] ${alert.appName} (v${alert.version})\n   📊 CHIẾN DỊCH PPO (A/B TEST)\n   🔹 Tên PPO   : ${alert.ppoName}\n   🔹 Traffic   : ${alert.traffic}\n   🔹 Trạng thái : ${colorCode}${alert.status}\u001b[0m\n` + "```";
  
  try { await axios.post(webhookUrl, { content: ansiMessage }); } catch (err) {}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ success: false, error: "Thiếu APPS_SCRIPT_URL!" });

    const initRes = await axios.post(APPS_SCRIPT_URL, { action: "getData" });
    const accounts = initRes.data.accounts || [];
    const oldCacheMap = initRes.data.cache || {};

    if (accounts.length === 0) return res.status(200).json({ success: true, message: "Tab [Cấu Hình] trống!" });

    let dashboardData = [];
    let newCacheMap = {}; 
    let hasChanges = false; 

    const fetchSingleAccountData = async (account) => {
      let rawKey = account.privateKey.trim().replace(/\\n/g, '\n');
      if (!rawKey.includes('\n')) {
        const body = rawKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
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

          let vInfos = versionLinks.map(vLink => included.find(item => item.id === vLink.id)).filter(Boolean);
          vInfos.sort((a, b) => (b.attributes.createdDate ? new Date(b.attributes.createdDate).getTime() : parseInt(b.id)) - (a.attributes.createdDate ? new Date(a.attributes.createdDate).getTime() : parseInt(a.id)));
          const vInfo = vInfos[0]; 
          
          const safeVersion = vInfo.attributes.versionString;
          const currentStatus = vInfo.attributes.appStoreState;
          const appCacheKey = `APP_${account.accountName}_${bundleId}_${safeVersion}`;
          
          newCacheMap[appCacheKey] = currentStatus;

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
                if (ppoStatus === "IN_REVIEW" || ppoStatus === "REJECTED") {
                  await sendDiscordAlert(DISCORD_WEBHOOK_URL, { type: "PPO", accountName: account.accountName, appName, version: safeVersion, status: ppoStatus, ppoName, traffic: ppoTraffic });
                }
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

    dashboardData.sort((a, b) => a[0] !== b[0] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1]));

    if (Object.keys(oldCacheMap).length !== Object.keys(newCacheMap).length) hasChanges = true;

    // KHI CÓ THAY ĐỔI -> GỬI LÊN GG SHEETS ĐỂ VẼ LẠI BẢNG (VÀ GHI NHỚ MỚI LUÔN)
    if (hasChanges) {
      await axios.post(APPS_SCRIPT_URL, { action: "updateDashboard", dashboardData: dashboardData });
      return res.status(200).json({ success: true, message: "Có biến động! Đã in lại Bảng Tổng Hợp." });
    } else {
      return res.status(200).json({ success: true, message: "Yên ắng. Không tốn 1 giọt tài nguyên nào!" });
    }
    
  } catch (error) {
    return res.status(500).json({ success: false, detail: error.message });
  }
};
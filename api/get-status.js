const jwt = require('jsonwebtoken');
const axios = require('axios');

// ==========================================
// HÀM GỬI DISCORD ĐÃ ĐƯỢC ĐÓNG GÓI SIÊU ĐẸP
// ==========================================
async function sendDiscordAlert(webhookUrl, accountName, appName, version, newStatus, bundleId, appId) {
  if (!webhookUrl || webhookUrl.includes("ĐIỀN_LINK_DISCORD")) return;
  
  let colorCode = "\u001b[1;30m"; let icon = "⚪";
  if (newStatus.includes("READY") || newStatus.includes("APPROVED")) { colorCode = "\u001b[1;32m"; icon = "🟢"; }
  else if (newStatus.includes("REVIEW") || newStatus.includes("WAITING") || newStatus.includes("PROCESSING")) { colorCode = "\u001b[1;33m"; icon = "🟡"; }
  else if (newStatus.includes("REJECTED")) { colorCode = "\u001b[1;31m"; icon = "🔴"; }

  // 1. Tạo khối thông điệp ANSI tối giản, gọn gàng và thẩm mỹ
  let ansiMessage = "```ansi\n" + 
    `${icon} [${accountName}] ${appName}\n` +
    `   🔹 Phiên bản : v${version}\n` +
    `   🔹 BundleID  : ${bundleId}\n` +
    `   🔹 Trạng thái : ${colorCode}${newStatus}\u001b[0m\n` +
    "```";

  // 2. CHỈ KHI READY_FOR_SALE MỚI ĐẺ LINK GAME VỚI TIÊU ĐỀ NGẮN GỌN
  if (newStatus === "READY_FOR_SALE") {
    const appStoreLink = `https://apps.apple.com/app/id${appId}`;
    ansiMessage += `\n🚀 [Link Game Trên App Store](<${appStoreLink}>)`;
  }
  
  try { 
    await axios.post(webhookUrl, { content: ansiMessage }); 
  } catch (err) { 
    console.error("Lỗi Discord:", err.message); 
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ success: false, error: "Thiếu cấu hình APPS_SCRIPT_URL trên Vercel!" });

    const accountsRes = await axios.post(APPS_SCRIPT_URL, { action: "getAccounts" });
    const accounts = accountsRes.data.accounts;

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({ success: true, message: "Hệ thống trống! Hãy điền tài khoản Apple Store vào tab [Cấu Hình] trên Sheets." });
    }

    const fetchSingleAccountData = async (account) => {
      let rawKey = account.privateKey.trim();
      if (!rawKey.includes('\n') && rawKey.includes('-----BEGIN PRIVATE KEY-----')) {
        rawKey = rawKey.replace(/\\n/g, '\n');
      }
      if (!rawKey.includes('\n')) {
        const body = rawKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s+/g, '');
        rawKey = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
      }

      const token = jwt.sign(
        { sub: "user", aud: "appstoreconnect-v1", exp: Math.floor(Date.now() / 1000) + 600 }, 
        rawKey, 
        { algorithm: 'ES256', header: { alg: 'ES256', kid: account.keyId, typ: 'JWT' }}
      );

      try {
        const response = await axios.get('https://api.appstoreconnect.apple.com/v1/apps?include=appStoreVersions', { headers: { 'Authorization': `Bearer ${token}` } });
        const apps = response.data.data;
        const included = response.data.included || [];
        let accountAppsData = [];

        for (const app of apps) {
          const appName = app.attributes.name;
          const cleanAppId = app.id;
          const bundleId = app.attributes.bundleId;
          
          let appVersions = [];
          const versionLinks = app.relationships.appStoreVersions.data || [];

          for (const vLink of versionLinks) {
            const vInfo = included.find(item => item.id === vLink.id && item.type === 'appStoreVersions');
            if (vInfo) {
              let ppoCampaigns = [];
              try {
                const ppoRes = await axios.get(`https://api.appstoreconnect.apple.com/v1/appStoreVersions/${vLink.id}/appStoreVersionExperimentsV2`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (ppoRes.data.data) ppoCampaigns = ppoRes.data.data;
              } catch (e) {}

              let ppos = ppoCampaigns.map(ppo => ({ name: ppo.attributes.name, state: ppo.attributes.state, traffic: ppo.attributes.trafficProportion ? `${ppo.attributes.trafficProportion}%` : "-" }));
              appVersions.push({ versionString: vInfo.attributes.versionString, status: vInfo.attributes.appStoreState, ppos: ppos });
            }
          }
          accountAppsData.push({ appName: appName, appId: cleanAppId, bundleId: bundleId, versions: appVersions });
        }
        return { accountName: account.accountName, apps: accountAppsData };
      } catch (err) {
        console.error(`Lỗi quét tài khoản ${account.accountName}:`, err.message);
        return { accountName: account.accountName, apps: [] };
      }
    };

    const batchResults = await Promise.all(accounts.map(acc => fetchSingleAccountData(acc)));

    const updateRes = await axios.post(APPS_SCRIPT_URL, { action: "updateSheets", results: batchResults });
    const alerts = updateRes.data.alerts || [];

    for (const alert of alerts) {
      await sendDiscordAlert(DISCORD_WEBHOOK_URL, alert.accountName, alert.appName, alert.version, alert.status, alert.bundleId, alert.appId);
    }

    return res.status(200).json({ success: true, message: "Hệ thống đã cập nhật mẫu card Discord VIP thành công!" });
  } catch (error) {
    return res.status(500).json({ success: false, detail: error.message });
  }
};
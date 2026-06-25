const jwt = require('jsonwebtoken');
const axios = require('axios');

async function sendDiscordAlert(webhookUrl, accountName, appName, version, newStatus) {
  if (!webhookUrl || webhookUrl.includes("ĐIỀN_LINK_DISCORD")) return;
  let colorCode = "\u001b[1;30m"; let icon = "⚪";
  if (newStatus.includes("READY") || newStatus.includes("APPROVED")) { colorCode = "\u001b[1;32m"; icon = "🟢"; }
  else if (newStatus.includes("REVIEW") || newStatus.includes("WAITING") || newStatus.includes("PROCESSING")) { colorCode = "\u001b[1;33m"; icon = "🟡"; }
  else if (newStatus.includes("REJECTED")) { colorCode = "\u001b[1;31m"; icon = "🔴"; }

  const ansiMessage = "```ansi\n" + `${icon} [${accountName}] ${appName} (v${version}) -> ${colorCode}${newStatus}\u001b[0m` + "\n```";
  try { await axios.post(webhookUrl, { content: ansiMessage }); } catch (err) { console.error("Lỗi Discord:", err.message); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

  try {
    if (!APPS_SCRIPT_URL) return res.status(500).json({ success: false, error: "Thiếu cấu hình APPS_SCRIPT_URL trên Vercel!" });

    // 1. Lấy danh sách tài khoản cần quét từ Google Sheets
    const accountsRes = await axios.post(APPS_SCRIPT_URL, { action: "getAccounts" });
    const accounts = accountsRes.data.accounts;

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({ success: true, message: "Tab [Cấu Hình] trên Sheets đang trống hoặc chưa điền!" });
    }

    // 2. Tiến hành quét Apple Store Connect API song song
    const fetchSingleAccountData = async (account) => {
      const formattedKey = account.privateKey.replace(/\\n/g, '\n');
      const token = jwt.sign(
        { sub: "user", aud: "appstoreconnect-v1", exp: Math.floor(Date.now() / 1000) + 600 }, 
        formattedKey, 
        { algorithm: 'ES256', header: { alg: 'ES256', kid: account.keyId, typ: 'JWT' }}
      );

      try {
        const response = await axios.get('https://api.appstoreconnect.apple.com/v1/apps?include=appStoreVersions', { headers: { 'Authorization': `Bearer ${token}` } });
        const apps = response.data.data;
        const included = response.data.included || [];
        let accountAppsData = [];

        for (const app of apps) {
          const appName = app.attributes.name;
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
          accountAppsData.push({ appName: appName, versions: appVersions });
        }
        return { accountName: account.accountName, apps: accountAppsData };
      } catch (err) {
        console.error(`Lỗi quét acc ${account.accountName}:`, err.message);
        return { accountName: account.accountName, apps: [] };
      }
    };

    const batchResults = await Promise.all(accounts.map(acc => fetchSingleAccountData(acc)));

    // 3. Gửi toàn bộ dữ liệu thô sang Google Sheets để nó tự làm nhiệm vụ "Vẽ Mỹ Thuật và Đè Lịch Sử"
    const updateRes = await axios.post(APPS_SCRIPT_URL, { action: "updateSheets", results: batchResults });
    const alerts = updateRes.data.alerts || [];

    // 4. Nếu Google Sheets báo có biến động trạng thái -> Bắn Discord ANSI đổi màu siêu tốc
    for (const alert of alerts) {
      await sendDiscordAlert(DISCORD_WEBHOOK_URL, alert.accountName, alert.appName, alert.version, alert.status);
    }

    return res.status(200).json({ success: true, message: "Hệ thống 100% Google Sheets đã cập nhật mỹ thuật và bắn Discord hoàn tất!" });
  } catch (error) {
    return res.status(500).json({ success: false, detail: error.message });
  }
};
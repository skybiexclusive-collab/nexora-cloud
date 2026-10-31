import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

const SHOPIER_API_KEY = process.env.SHOPIER_API_KEY || "TEST_KEY";
const SHOPIER_API_SECRET = process.env.SHOPIER_API_SECRET || "TEST_SECRET";
const SITE_URL = process.env.SITE_URL || `https://${process.env.RAILWAY_STATIC_URL || 'localhost:3000'}`;
const PORT = process.env.PORT || 3000;

const DATA_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vps_pool.json')
  : './vps_pool.json';

function getPool() {
  if (!fs.existsSync(DATA_PATH)) {
    if (fs.existsSync('./vps_pool.json')) {
      const defaultData = fs.readFileSync('./vps_pool.json', 'utf-8');
      fs.writeFileSync(DATA_PATH, defaultData);
      return JSON.parse(defaultData);
    }
    return [];
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

function savePool(pool) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(pool, null, 2));
}

function cleanExpiredVPS(pool) {
  const now = new Date();
  let changed = false;

  pool.forEach(vps => {
    if (vps.status === 'assigned' && vps.expiresAt) {
      if (new Date(vps.expiresAt) < now) {
        console.log(`[Süre Doldu] VPS serbest bırakıldı: ${vps.ip}`);
        vps.status = 'available';
        vps.assignedTo = null;
        vps.expiresAt = null;
        changed = true;
      }
    }
  });

  if (changed) savePool(pool);
  return pool;
}

app.get('/api/vps-stock', (req, res) => {
  let pool = cleanExpiredVPS(getPool());
  const availableCount = pool.filter(v => v.status === 'available').length;
  res.json({
    available: availableCount > 0,
    count: availableCount,
    name: "Spaceship 7 Günlük Cloud VPS"
  });
});

app.post('/api/pay-shopier', (req, res) => {
  const { userEmail, userName, userPhone } = req.body;
  let pool = cleanExpiredVPS(getPool());

  const availableVps = pool.find(v => v.status === 'available');
  if (!availableVps) {
    return res.status(400).send("Üzgünüz! Tüm VPS paketlerimiz şu an doludur.");
  }

  const orderId = `VPS-${Date.now()}`;
  const totalVal = "399.00";
  const currency = 0;

  availableVps.status = 'reserved';
  availableVps.assignedTo = orderId;
  savePool(pool);

  const signatureData = `${SHOPIER_API_KEY}${orderId}${totalVal}${currency}`;
  const signature = crypto
    .createHmac('sha256', SHOPIER_API_SECRET)
    .update(signatureData)
    .digest('base64');

  const formHtml = `
    <!DOCTYPE html>
    <html>
      <body onload="document.getElementById('shopier_form').submit();" style="background:#05070f; color:#fff; font-family:sans-serif; text-align:center; padding-top:60px;">
        <form id="shopier_form" method="POST" action="https://www.shopier.com/ShowProduct/api_pay4.php">
          <input type="hidden" name="API_key" value="${SHOPIER_API_KEY}">
          <input type="hidden" name="website_index" value="1">
          <input type="hidden" name="platform_order_id" value="${orderId}">
          <input type="hidden" name="product_name" value="Spaceship 7 Gunluk Cloud VPS">
          <input type="hidden" name="product_type" value="1">
          <input type="hidden" name="buyer_name" value="${userName || 'Musteri'}">
          <input type="hidden" name="buyer_surname" value="Kullanici">
          <input type="hidden" name="buyer_email" value="${userEmail}">
          <input type="hidden" name="buyer_phone" value="${userPhone || '05555555555'}">
          <input type="hidden" name="billing_address" value="Turkiye">
          <input type="hidden" name="billing_city" value="Istanbul">
          <input type="hidden" name="billing_country" value="Turkiye">
          <input type="hidden" name="total_order_value" value="${totalVal}">
          <input type="hidden" name="currency" value="${currency}">
          <input type="hidden" name="current_language" value="0">
          <input type="hidden" name="modul_version" value="1.0.4">
          <input type="hidden" name="random_nr" value="${orderId}">
          <input type="hidden" name="signature" value="${signature}">
          <input type="hidden" name="callback_url" value="${SITE_URL}/api/shopier-callback">
        </form>
        <p>Shopier güvenli ödeme ekranına aktarılıyorsunuz...</p>
      </body>
    </html>
  `;
  res.send(formHtml);
});

app.post('/api/shopier-callback', (req, res) => {
  const { platform_order_id, status, random_nr, signature } = req.body;
  let pool = getPool();

  const expectedData = `${random_nr}${platform_order_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', SHOPIER_API_SECRET)
    .update(expectedData)
    .digest('base64');

  if (signature !== expectedSignature) {
    return res.status(400).send("İmza doğrulaması başarısız!");
  }

  const vpsIndex = pool.findIndex(v => v.assignedTo === platform_order_id);

  if (status && status.toLowerCase() === 'success') {
    if (vpsIndex !== -1) {
      const expireDate = new Date();
      expireDate.setDate(expireDate.getDate() + 7);

      pool[vpsIndex].status = 'assigned';
      pool[vpsIndex].expiresAt = expireDate.toISOString();
      savePool(pool);

      return res.redirect(`${SITE_URL}/index.html?vpsId=${platform_order_id}`);
    } else {
      return res.redirect(`${SITE_URL}/index.html?status=outofstock`);
    }
  } else {
    if (vpsIndex !== -1) {
      pool[vpsIndex].status = 'available';
      pool[vpsIndex].assignedTo = null;
      savePool(pool);
    }
    return res.redirect(`${SITE_URL}/index.html?status=failed`);
  }
});

app.get('/api/vps-ip/:instanceId', (req, res) => {
  const { instanceId } = req.params;
  const pool = getPool();
  const assignedVps = pool.find(v => v.assignedTo === instanceId && v.status === 'assigned');

  if (!assignedVps) {
    return res.status(404).json({ error: 'Sunucu teslimata hazır değil.' });
  }

  res.json({
    status: 'active',
    ip: assignedVps.ip,
    user: assignedVps.user,
    password: assignedVps.password,
    port: assignedVps.port,
    expiresAt: assignedVps.expiresAt
  });
});

app.listen(PORT, () => {
  console.log(`Nexora Cloud Engine ${PORT} portunda devrede.`);
});

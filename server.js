const express    = require('express');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');
const fetch      = require('node-fetch'); // npm install node-fetch@2

const app        = express();
const DATA_DIR   = path.join(__dirname, 'data');
const SETTINGS   = path.join(DATA_DIR, 'settings.json');
const DOMAINS    = path.join(DATA_DIR, 'domains.json');
const USAGES     = path.join(DATA_DIR, 'usages.json');
const TUTORIAL   = path.join(DATA_DIR, 'tutorial.json');

// init data folder & files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS)) {
  console.error('⚠️  data/settings.json Not Found');
  process.exit(1);
}
if (!fs.existsSync(DOMAINS))  fs.writeFileSync(DOMAINS, '{}', 'utf8');
if (!fs.existsSync(USAGES))   fs.writeFileSync(USAGES, '{}', 'utf8');
if (!fs.existsSync(TUTORIAL)) fs.writeFileSync(TUTORIAL, '{}', 'utf8');

// helper loaders/savers
function loadJSON(fp) { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
function saveJSON(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2), 'utf8'); }
function loadDomains() { return loadJSON(DOMAINS); }
function saveDomains(d) { saveJSON(DOMAINS, d); }
function loadUsages()  { return loadJSON(USAGES); }

const port = 3000;
// load settings & usages config
const { cloudflare } = loadJSON(SETTINGS);
const usagesConfig = loadUsages();

// middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
// serve tutorial.json under /data
app.use('/data', express.static(path.join(__dirname, 'data')));

// 1) daftar usages
app.get('/api/usages', (req, res) => {
  const filtered = {};
  for (const key of Object.keys(usagesConfig)) {
    const { name, fields } = usagesConfig[key];
    filtered[key] = { name, fields };
  }
  res.json(filtered);
});
// 2) daftar domains (existing)
app.get('/api/domains', (req, res) => {
  // 1. Load dan filter domains
  const domains = loadDomains();
  const filteredDomains = Object.fromEntries(
    Object.entries(domains).map(([sub, doc]) => [
      sub,
      { status: doc.status, date: doc.date, domain: doc.domain }
    ])
  );

  // 2. Load settings.json dan ambil hanya nama domain (key)
  let settingKeys = [];
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    const settingsJson = JSON.parse(raw);
    settingKeys = Object.keys(settingsJson);
  } catch (err) {
    console.error('Gagal load settings.json:', err);
    // tetap lanjut dengan array kosong
  }

  // 3. Kirim response (tanpa data sensitif)
  res.json({
    domains:  filteredDomains,
    settings: settingKeys
  });
});

app.get('/api/all-domain', (req, res) => {
  try {
    const dataPath = path.join(__dirname, 'data', 'domains.json')
    const raw      = fs.readFileSync(dataPath, 'utf8')
    const domains  = JSON.parse(raw)

    // Daftar field yang akan ditampilkan
    const whitelist = ['domain', 'status']

    // Bangun objek baru hanya dengan field di whitelist
    const filtered = Object.entries(domains).reduce((acc, [key, entry]) => {
      acc[key] = whitelist.reduce((obj, field) => {
        if (entry[field] !== undefined) obj[field] = entry[field]
        return obj
      }, {})
      return acc
    }, {})

    res.json(filtered)
  } catch (err) {
    console.error('Failed to read domains:', err)
    res.status(500).json({ error: 'Failed to load domains' })
  }
})

// 3. Redirect /domains → our static page
app.get('/domains', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'domains.html'); // Sesuaikan path-nya ya
  fs.readFile(htmlPath, 'utf8', (err, html) => {
    if (err) {
      console.error('Error reading HTML file:', err);
      return res.status(500).send('Internal Server Error');
    }
    res.set('Content-Type', 'text/html');
    res.send(html);
  });
});

// 3) cek availability
app.get('/api/check', (req, res) => {
  const sub = (req.query.subdomain || '').trim().toLowerCase();
  const baseDomain = (req.query.baseDomain || '').trim().toLowerCase();

  if (!sub || !baseDomain) {
    return res.status(400).json({ error: 'Missing subdomain or baseDomain' });
  }

  const domains = loadDomains(); // ← Ini harus return object kayak {"docs": {...}}

  const taken = Object.entries(domains).some(([key, value]) => {
    return key === sub && value.domain === baseDomain;
  });

  res.json({ available: !taken });
});


app.post('/request', async (req, res) => {
  // 1. Captcha verification (same as before)
  const captcha = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'captcha.json'), 'utf8'));
  const token   = req.body["g-recaptcha-response"];

  try {
    const params     = new URLSearchParams();
    params.append('secret', captcha.secret);
    params.append('response', token);

    const verifyRes  = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const verifyJson = await verifyRes.json();
    if (!verifyJson.success) {
      return res.redirect(`/?action=failed&message=${encodeURIComponent('Captcha verification failed.')}`);
    }
  } catch (e) {
    console.error('Captcha error:', e);
    return res.redirect(`/?action=error&message=${encodeURIComponent('Captcha verification error.')}`);
  }

  // 2. Extract inputs
  const { owner, subdomain, usage, email, baseDomain, ...rest } = req.body;
  if (!baseDomain) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Please choose a target domain.')}`);
  }

  // 3. Validate subdomain format
  const key = subdomain.trim().toLowerCase();
  const isValidSubdomain = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
  if (!isValidSubdomain) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent(
      'Invalid subdomain. Only lowercase letters, numbers, and hyphens (-) allowed. Cannot start or end with a hyphen.'
    )}`);
  }

  // 4. Check availability on this baseDomain only
  const domains = loadDomains();
  if (domains[key] && domains[key].domain === baseDomain) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Subdomain already exists on that domain.')}`);
  }

  // 5. Save into domains.json (status requested)
  domains[key] = {
    owner,
    email,
    usage,
    config: rest,
    status: 'requested',
    date: new Date().toISOString(),
    domain: baseDomain
  };
  saveDomains(domains);

  // 6. Load settings.json & Cloudflare config
  let settingsJson;
  try {
    settingsJson = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    console.error('Cannot read settings.json', err);
    return res.redirect(`/?action=error&message=${encodeURIComponent('Server error reading configuration.')}`);
  }
  const domainCfg = settingsJson[baseDomain]?.cloudflare;
  if (!domainCfg) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Invalid domain or missing Cloudflare configuration.')}`);
  }
  const { apiToken, zoneId } = domainCfg;

  // 7. Integrate with Cloudflare per usagesConfig
  const usageEntry = usagesConfig[usage];
  if (usageEntry?.integration) {
    const integrations = Array.isArray(usageEntry.integration)
      ? usageEntry.integration
      : [usageEntry.integration];

    for (const cfg of integrations) {
      if (cfg.provider !== 'cloudflare') continue;

      // Build recordName
      let recordName;
      if (cfg.nameField) {
        recordName = req.body[cfg.nameField];
      } else {
        recordName = cfg.nameTemplate
          .replace(/{{subdomain}}/g, key)
          .replace(/{{domain}}/g, baseDomain);
        const suffix = `.${baseDomain}`;
        if (recordName.endsWith(suffix)) {
          recordName = recordName.slice(0, -suffix.length);
        }
      }

      // Prepare record payload
      const record = {
        type: cfg.recordType,
        name: recordName,
        content: cfg.recordType === 'TXT'
          ? `"${req.body[cfg.contentField] || cfg.content}"`
          : req.body[cfg.contentField] || cfg.content,
        ttl: cfg.ttl,
        ...(cfg.recordType !== 'TXT' && { proxied: cfg.proxied })
      };

      try {
        const cfRes  = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(record)
          }
        );
        const cfJson = await cfRes.json();
        if (cfJson.success) {
          domains[key].status = 'success';
          saveDomains(domains);
        } else {
          console.error('Cloudflare error:', cfJson.errors || cfJson);
        }
      } catch (err) {
        console.error('Failed to setup Cloudflare:', err);
      }
    }
  }

  // 8. Redirect dengan success flag
  res.redirect(`/?success=1&sub=${encodeURIComponent(key)}&usage=${encodeURIComponent(usage)}`);
});


app.post('/delete', async (req, res) => {
  // 1. Captcha verification
  const captcha = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'captcha.json'), 'utf8'));
  const token   = req.body["g-recaptcha-response"];

  try {
    const params     = new URLSearchParams();
    params.append('secret', captcha.secret);
    params.append('response', token);

    const verifyRes  = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const verifyJson = await verifyRes.json();
    if (!verifyJson.success) {
      return res.redirect(`/?action=failed&message=${encodeURIComponent('Captcha verification failed.')}`);
    }
  } catch (e) {
    console.error('Captcha error:', e);
    return res.redirect(`/?action=error&message=${encodeURIComponent('Captcha verification error.')}`);
  }

  // 2. Extract inputs
  const { owner, subdomain, email, baseDomain } = req.body;
  if (!subdomain || !baseDomain || !owner || !email) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Please provide subdomain, baseDomain, owner, and email.')}`);
  }
  const key = subdomain.trim().toLowerCase();

  // 3. Load and validate domains.json
  const domains = loadDomains();
  const entry   = domains[key];
  if (!entry) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Subdomain not found.')}`);
  }
  if (entry.owner !== owner || entry.email !== email || entry.domain !== baseDomain) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Owner or email does not match.')}`);
  }

  // 4. Load Cloudflare config
  let settingsJson;
  try {
    settingsJson = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    console.error('Cannot read settings.json', err);
    return res.redirect(`/?action=error&message=${encodeURIComponent('Server error reading configuration.')}`);
  }
  const domainCfg = settingsJson[baseDomain]?.cloudflare;
  if (!domainCfg) {
    return res.redirect(`/?action=failed&message=${encodeURIComponent('Invalid domain or missing Cloudflare configuration.')}`);
  }
  const { apiToken, zoneId } = domainCfg;

  // 5. Fetch DNS records from Cloudflare
  const recordName = `${key}.${baseDomain}`;
  try {
    const listRes  = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${recordName}`,
      { headers: { 'Authorization': `Bearer ${apiToken}` } }
    );
    const listJson = await listRes.json();
    if (!listJson.success) {
      console.error('Cloudflare list error:', listJson.errors);
      return res.redirect(`/?action=error&message=${encodeURIComponent('Failed to fetch DNS records.')}`);
    }

    // 6. Delete each record found
    for (const rec of listJson.result) {
      const delRes  = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rec.id}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${apiToken}` }
        }
      );
      const delJson = await delRes.json();
      if (!delJson.success) {
        console.error('Cloudflare delete error:', delJson.errors);
        // continue deleting others
      }
    }
  } catch (err) {
    console.error('Error integrating with Cloudflare:', err);
    return res.redirect(`/?action=error&message=${encodeURIComponent('Error deleting records in Cloudflare.')}`);
  }

  // 7. Remove from domains.json and save
  delete domains[key];
  saveDomains(domains);

  // 8. Redirect with success
  return res.redirect(`/?action=success&message=${encodeURIComponent(`Subdomain ${key}.${baseDomain} deleted successfully.`)}`);
});



// start server
app.listen(port, () => console.log(`🚀 Listening on http://localhost:${port}`));

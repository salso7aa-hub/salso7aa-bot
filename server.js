const express = require('express');
const https = require('https');
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');

const app = express();
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const GUILD_ID       = process.env.GUILD_ID;
const REDIRECT_URI   = process.env.REDIRECT_URI || 'https://salso7aa-bot-production.up.railway.app/auth/callback';
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE || 'salso7aa-2.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;
const PORT           = process.env.PORT || 3000;

// ── DISCORD BOT ──────────────────────────────────────────────────────────────
const bot = new Client({
  intents: [GatewayIntentBits.Guilds]
});

bot.once('ready', () => console.log(`Bot ready: ${bot.user.tag}`));
bot.login(BOT_TOKEN);

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.send('Salso7aa Bot is running ✅'));

// Step 1 — redirect customer to Discord OAuth
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'identify email',
  });
  res.redirect('https://discord.com/oauth2/authorize?' + params.toString());
});

// Step 2 — Discord redirects back here with a code
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code.');

  try {
    // Exchange code → access token
    const tokenRes = await discordPost('https://discord.com/api/oauth2/token', {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
    });

    if (!tokenRes.access_token) throw new Error('Discord token exchange failed: ' + JSON.stringify(tokenRes));

    // Get Discord user info
    const discordUser = await discordGet('https://discord.com/api/users/@me', tokenRes.access_token);
    if (!discordUser.email) throw new Error('Could not retrieve Discord email.');

    // Find matching Shopify customer
    const customer = await shopifyGetCustomerByEmail(discordUser.email);
    if (!customer) {
      return res.send(page('❌ Account not found',
        `No Shopify account was found with your Discord email <strong>${discordUser.email}</strong>.<br>
         Make sure you used the same email when placing your order.`,
        'error'
      ));
    }

    // Save Discord ID + username as customer metafields
    await shopifySetMetafield(customer.id, 'user_id',  discordUser.id);
    await shopifySetMetafield(customer.id, 'username', discordUser.username);

    return res.send(page('✅ Discord Connected!',
      `Your Discord account <strong>${discordUser.username}</strong> has been linked to your store account.<br>
       From now on, every purchase will automatically open a ticket in our Discord server.`,
      'success'
    ));

  } catch (err) {
    console.error('OAuth error:', err);
    return res.status(500).send(page('Something went wrong', err.message, 'error'));
  }
});

// Step 3 — Shopify fires this when an order is paid
app.post('/webhooks/orders-paid', async (req, res) => {
  // Respond immediately so Shopify doesn't retry
  res.sendStatus(200);

  const order = req.body;
  const email      = order.email;
  const orderName  = order.name || '#' + order.order_number;
  const total      = `${order.total_price} ${order.currency}`;
  const items      = (order.line_items || [])
    .map(i => `• ${i.name} × ${i.quantity}`)
    .join('\n') || 'No items';

  console.log(`Order paid: ${orderName} — ${email}`);

  try {
    const customer = await shopifyGetCustomerByEmail(email);
    if (!customer) return console.log('No customer found for', email);

    const metafields   = await shopifyGetMetafields(customer.id);
    const discordId    = metafields.find(m => m.namespace === 'discord' && m.key === 'user_id')?.value;
    const discordUser  = metafields.find(m => m.namespace === 'discord' && m.key === 'username')?.value || 'Customer';

    if (!discordId) {
      return console.log(`Customer ${email} has not connected Discord.`);
    }

    await createTicket({ discordId, discordUser, orderName, items, total, email });

  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// ── TICKET CREATOR ───────────────────────────────────────────────────────────
async function createTicket({ discordId, discordUser, orderName, items, total, email }) {
  await bot.guilds.fetch(); // ensure cache is fresh
  const guild = bot.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error('Guild not found:', GUILD_ID);

  // Find or create a "Tickets" category
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'tickets'
  );
  if (!category) {
    category = await guild.channels.create({
      name: 'Tickets',
      type: ChannelType.GuildCategory,
    });
    console.log('Created Tickets category');
  }

  // Sanitise channel name
  const safeName = discordUser.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  const safeOrder = orderName.replace('#', '');
  const channelName = `ticket-${safeName}-${safeOrder}`;

  // Create private channel visible only to the customer + everyone with Manage Channels
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id:   guild.roles.everyone,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id:    discordId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
  });

  // Send the order summary embed
  await channel.send({
    content: `<@${discordId}>`,
    embeds: [{
      color: 0x7b2fff,
      title: `🎟️ Order Ticket — ${orderName}`,
      description:
        `Hey **${discordUser}**, your order has been received! 🎉\n\n` +
        `Our team will deliver your item in-game as soon as possible.\n` +
        `Please stay in this channel and we will message you here.`,
      fields: [
        { name: '📦 Items',    value: items,  inline: false },
        { name: '💰 Total',    value: total,  inline: true  },
        { name: '📧 Email',    value: email,  inline: true  },
      ],
      footer: { text: 'Salso7aa Store • Thank you for your purchase!' },
      timestamp: new Date().toISOString(),
    }],
  });

  console.log(`Ticket created: #${channelName}`);
}

// ── SHOPIFY HELPERS ───────────────────────────────────────────────────────────
function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SHOPIFY_STORE,
      path:     '/admin/api/2026-04' + path,
      method,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type':           'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function shopifyGetCustomerByEmail(email) {
  const res = await shopifyRequest('GET', `/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`);
  return res.customers?.[0] || null;
}

async function shopifyGetMetafields(customerId) {
  const res = await shopifyRequest('GET', `/customers/${customerId}/metafields.json`);
  return res.metafields || [];
}

async function shopifySetMetafield(customerId, key, value) {
  // Check if it already exists
  const existing = await shopifyGetMetafields(customerId);
  const found = existing.find(m => m.namespace === 'discord' && m.key === key);
  if (found) {
    // Update
    await shopifyRequest('PUT', `/customers/${customerId}/metafields/${found.id}.json`, {
      metafield: { id: found.id, value, type: 'single_line_text_field' }
    });
  } else {
    // Create
    await shopifyRequest('POST', `/customers/${customerId}/metafields.json`, {
      metafield: { namespace: 'discord', key, value, type: 'single_line_text_field' }
    });
  }
}

// ── DISCORD HELPERS ───────────────────────────────────────────────────────────
function discordPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function discordGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'GET',
      headers: { Authorization: 'Bearer ' + token },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── HTML PAGE HELPER ─────────────────────────────────────────────────────────
function page(title, body, type) {
  const color = type === 'success' ? '#7b2fff' : '#ff4444';
  const icon  = type === 'success' ? '✅' : '❌';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Salso7aa</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0a0a0a;color:#fff;min-height:100vh;
         display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#111;border:1px solid #222;border-radius:16px;
          padding:48px 40px;max-width:480px;width:100%;text-align:center}
    .icon{font-size:56px;margin-bottom:20px}
    h1{font-size:24px;font-weight:700;margin-bottom:12px;color:${color}}
    p{color:#aaa;line-height:1.6;font-size:15px}
    a{display:inline-block;margin-top:28px;padding:12px 28px;
      background:${color};color:#fff;text-decoration:none;
      border-radius:8px;font-weight:600;font-size:14px}
    a:hover{opacity:.85}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="https://salso7aa-2.myshopify.com">← Back to store</a>
  </div>
</body>
</html>`;
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

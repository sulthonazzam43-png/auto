const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const helper = require('./utils/helper');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Please create config.json and set your bot_token and admin_id');
  process.exit(1);
}
const config = fs.readJsonSync(CONFIG_PATH);

if (!config.bot_token || config.bot_token.startsWith('GANTI')) {
  console.error('Set "bot_token" in config.json before running.');
  process.exit(1);
}

const bot = new Telegraf(config.bot_token);
bot.use(session());

const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

for (const f of [PRODUCTS_FILE, USERS_FILE, ORDERS_FILE]) {
  if (!fs.existsSync(f)) fs.writeJsonSync(f, []);
}

const utils = {
  read: (f) => { try { return fs.readJsonSync(f); } catch(e){ return []; } },
  write: (f,d) => { try { fs.writeJsonSync(f,d,{spaces:2}); } catch(e){ console.error('write err',e); } }
};

// cooldown map
const cooldowns = {};

function allowClick(userId){
  const now = Date.now();
  const until = cooldowns[userId] || 0;
  return now >= until;
}
function setCooldown(userId, sec){
  cooldowns[userId] = Date.now() + (sec*1000);
}

function mainMenu(){
  const kb = Markup.inlineKeyboard([
    [ Markup.button.callback('🛍 Produk Tersedia', 'list_products') ],
    [ Markup.button.callback('📦 Cara Pemesanan', 'how_to_order') ]
  ]);
  return kb;
}

function adminMenu(){
  return Markup.inlineKeyboard([
    [ Markup.button.callback('➕ Tambah Produk','add_product') ],
    [ Markup.button.callback('❌ Hapus Produk','delete_product') ],
    [ Markup.button.callback('📋 List Produk','list_products_admin') ],
    [ Markup.button.callback('📊 Statistik','stats') ],
    [ Markup.button.callback('⬅️ Kembali','back_to_main') ]
  ]);
}

async function doLoading(ctx){
  try{
    const m1 = await ctx.reply('⏳ Loading...');
    await new Promise(r=>setTimeout(r,350));
    await ctx.deleteMessage(m1.message_id).catch(()=>{});
    const m2 = await ctx.reply('⌛ Menghubungkan layanan...');
    await new Promise(r=>setTimeout(r,500));
    await ctx.deleteMessage(m2.message_id).catch(()=>{});
  }catch(e){ }
}

bot.start(async (ctx) => {
  try {
    const users = utils.read(USERS_FILE);
    if (!users.find(u=>u.id===ctx.from.id)) {
      users.push({ id: ctx.from.id, username: ctx.from.username||null, first_name: ctx.from.first_name||null, created: new Date().toISOString() });
      utils.write(USERS_FILE, users);
    }
    await doLoading(ctx);
    const welcome = `👋 Halo, <b>${ctx.from.first_name||'Pembeli'}</b>!\nSelamat datang di <b>${config.store_name}</b>\nPilih menu di bawah untuk mulai belanja:`;
    if (ctx.from.id === config.admin_id) {
      await ctx.replyWithHTML(welcome, adminMenu());
    } else {
      await ctx.replyWithHTML(welcome, mainMenu());
    }
  } catch(e){ console.error('start err', e); }
});

bot.action('back_to_main', async (ctx) => {
  try{
    if (ctx.from.id === config.admin_id) {
      await ctx.editMessageText('👑 Panel Admin', adminMenu());
    } else {
      await ctx.editMessageText('🏠 Menu Utama', mainMenu());
    }
  } catch {
    if (ctx.from.id === config.admin_id) await ctx.reply('👑 Panel Admin', adminMenu());
    else await ctx.reply('🏠 Menu Utama', mainMenu());
  }
});

bot.action('how_to_order', async (ctx) => {
  const txt = `📦 <b>Cara Pemesanan</b>\n\n1. Klik Produk Tersedia\n2. Pilih produk\n3. Pilih metode pembayaran\n4. Setelah transfer, kirim bukti pembayaran (foto) di chat ini`;
  try { await ctx.editMessageText(txt, { parse_mode: 'HTML', ...mainMenu().reply_markup }); }
  catch { await ctx.replyWithHTML(txt, mainMenu()); }
});

bot.action('list_products', async (ctx) => {
  try{
    if (!allowClick(ctx.from.id)) return ctx.answerCbQuery('⚠️ Tunggu beberapa detik...');
    setCooldown(ctx.from.id, config.click_cooldown_sec||5);
    const products = utils.read(PRODUCTS_FILE);
    if (!products || !products.length) return ctx.reply('⚠️ Belum ada produk.', mainMenu());
    const rows = products.map(p => [ Markup.button.callback(`${p.name} — Rp${p.price}`, `buy_${p.id}`) ]);
    rows.push([ Markup.button.callback('⬅️ Kembali', 'back_to_main') ]);
    try {
      await ctx.editMessageText('🛍 <b>Daftar Produk</b>\nPilih produk untuk melihat metode pembayaran:', { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    } catch {
      await ctx.replyWithHTML('🛍 <b>Daftar Produk</b>\nPilih produk untuk melihat metode pembayaran:', Markup.inlineKeyboard(rows));
    }
  } catch(e){ console.error('list prod err', e); }
});

bot.action(/buy_(.+)/, async (ctx) => {
  try{
    if (!allowClick(ctx.from.id)) return ctx.answerCbQuery('⚠️ Tunggu beberapa detik...');
    setCooldown(ctx.from.id, config.click_cooldown_sec||5);
    const id = ctx.match[1];
    const products = utils.read(PRODUCTS_FILE);
    const p = products.find(x=>String(x.id)===String(id));
    if (!p) return ctx.reply('❌ Produk tidak ditemukan.');
    const orders = utils.read(ORDERS_FILE);
    const orderId = uuidv4().split('-')[0];
    const order = { id: orderId, user_id: ctx.from.id, product_id: p.id, product_name: p.name, price: p.price, status: 'pending', created_at: new Date().toISOString(), method: null };
    orders.push(order);
    utils.write(ORDERS_FILE, orders);
    const kb = Markup.inlineKeyboard([
      [ Markup.button.callback('💳 QRIS', `pay_qris_${orderId}`) ],
      [ Markup.button.callback('📱 DANA', `pay_dana_${orderId}`) ],
      [ Markup.button.callback('⬅️ Kembali', 'list_products') ]
    ]);
    try { await ctx.editMessageText(`✅ Order dibuat. Order ID: <b>${orderId}</b>\nProduk: <b>${p.name}</b>\nHarga: <b>Rp${p.price}</b>\n\nPilih metode pembayaran:`, { parse_mode:'HTML', reply_markup: kb.reply_markup }); }
    catch { await ctx.replyWithHTML(`✅ Order dibuat. Order ID: <b>${orderId}</b>\nProduk: <b>${p.name}</b>\nHarga: <b>Rp${p.price}</b>\n\nPilih metode pembayaran:`, kb); }
    try { await bot.telegram.sendMessage(config.admin_id, `🛎️ Order baru ${orderId}\nUser: ${ctx.from.username||ctx.from.first_name}\nProduk: ${p.name}\nHarga: Rp${p.price}`); } catch(e){}
  } catch(e){ console.error('buy err', e); }
});

bot.action(/pay_qris_(.+)/, async (ctx) => {
  try{
    const orderId = ctx.match[1];
    const orders = utils.read(ORDERS_FILE);
    const order = orders.find(o=>o.id===orderId && o.user_id===ctx.from.id);
    if (!order) return ctx.reply('Order tidak ditemukan.');
    order.method = 'QRIS';
    utils.write(ORDERS_FILE, orders);
    await ctx.replyWithHTML(`Silakan scan QRIS berikut dan kirim bukti transfer (foto) di chat ini.\nOrder ID: <b>${orderId}</b>`);
    try { await ctx.replyWithPhoto({ url: config.qris_image }); } catch { await ctx.reply('QRIS: '+config.qris_image); }
  } catch(e){ console.error('pay_qris err', e); await ctx.reply('Terjadi kesalahan saat menampilkan QRIS.'); }
});

bot.action(/pay_dana_(.+)/, async (ctx) => {
  try{
    const orderId = ctx.match[1];
    const orders = utils.read(ORDERS_FILE);
    const order = orders.find(o=>o.id===orderId && o.user_id===ctx.from.id);
    if (!order) return ctx.reply('Order tidak ditemukan.');
    if (!config.dana_number) return ctx.reply('Nomor DANA belum diset oleh admin.');
    order.method = 'DANA';
    utils.write(ORDERS_FILE, orders);
    await ctx.replyWithHTML(`Silakan transfer via DANA ke:\n<b>${config.dana_number}</b>\nOrder ID: <b>${orderId}</b>\nSetelah transfer, kirim bukti (foto) di chat ini.`);
  } catch(e){ console.error('pay_dana err', e); await ctx.reply('Terjadi kesalahan saat memproses DANA.'); }
});

bot.on('photo', async (ctx) => {
  try{
    const orders = utils.read(ORDERS_FILE);
    const pending = orders.filter(o=>o.user_id===ctx.from.id && o.status==='pending').slice(-1)[0];
    if (!pending) return ctx.reply('Tidak ada order yang menunggu bukti transfer. Pastikan kamu membuat order terlebih dahulu.');
    const photo = ctx.message.photo.pop();
    pending.proof_file_id = photo.file_id;
    pending.status = 'awaiting_confirmation';
    pending.proof_at = new Date().toISOString();
    utils.write(ORDERS_FILE, orders);
    await ctx.reply('✅ Bukti pembayaran diterima. Admin akan segera memeriksa.');
    const caption = `📥 Bukti Pembayaran\nOrder ID: ${pending.id}\nUser: @${ctx.from.username||ctx.from.first_name}\nProduk: ${pending.product_name}\nMetode: ${pending.method||'Unknown'}`;
    try {
      await bot.telegram.sendPhoto(config.admin_id, photo.file_id, { caption });
    } catch(e){ console.error('forward err', e); }
  } catch(e){ console.error('photo handler err', e); await ctx.reply('Gagal memproses bukti.'); }
});

bot.action('menu_admin', async (ctx)=>{
  try{
    await ctx.answerCbQuery().catch(()=>{});
    if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.',{show_alert:true});
    const kb = Markup.inlineKeyboard([
      [ Markup.button.callback('➕ Tambah Produk','admin_addp'), Markup.button.callback('➖ Hapus Produk','admin_rmp') ],
      [ Markup.button.callback('📋 List Produk','admin_list'), Markup.button.callback('📊 Statistik','admin_stats') ],
      [ Markup.button.callback('🔙 Kembali','back_to_main') ]
    ]);
    try{ await ctx.editMessageText('👑 Panel Admin:', { reply_markup: kb.reply_markup }); }catch(e){ await ctx.reply('👑 Panel Admin:', kb); }
  }catch(e){ utils.log('menu_admin error '+(e.message||e)); }
});


bot.action('add_product', async (ctx) => {
  if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.');
  ctx.session = { mode: 'add' };
  await ctx.reply('Kirim data produk baru dengan format: Nama | Harga'); 
});

bot.on('text', async (ctx) => {
  if (ctx.session && ctx.session.mode === 'add' && ctx.from.id === config.admin_id) {
    const parts = ctx.message.text.split('|').map(s=>s.trim());
    if (parts.length < 2) return ctx.reply('Format salah. Contoh: VIP 1 Bulan | 15000');
    const name = parts[0];
    const price = parseInt(parts[1].replace(/[^\d]/g,'')) || 0;
    const products = utils.read(PRODUCTS_FILE);
    const id = products.length ? Math.max(...products.map(p=>p.id))+1 : 1;
    products.push({ id, name, price, stock: 999 });
    utils.write(PRODUCTS_FILE, products);
    ctx.session = null;
    await ctx.reply(`✅ Produk ${name} ditambahkan.`);
  }
});

bot.action('delete_product', async (ctx) => {
  if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.');
  const products = utils.read(PRODUCTS_FILE);
  if (!products.length) return ctx.reply('Tidak ada produk.');
  const rows = products.map(p => [ Markup.button.callback(`❌ ${p.name}`, `del_${p.id}`) ]);
  rows.push([ Markup.button.callback('⬅️ Kembali', 'back_to_main') ]);
  await ctx.reply('Pilih produk untuk dihapus:', Markup.inlineKeyboard(rows));
});

bot.action(/del_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.');
  const id = ctx.match[1];
  const products = utils.read(PRODUCTS_FILE).filter(p=>String(p.id)!==String(id));
  utils.write(PRODUCTS_FILE, products);
  await ctx.reply('✅ Produk dihapus.');
});

bot.action('list_products_admin', async (ctx) => {
  if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.');
  const products = utils.read(PRODUCTS_FILE);
  if (!products.length) return ctx.reply('Tidak ada produk.');
  let text = '📋 Daftar Produk:\n\n';
  products.forEach(p=> text += `• ${p.id} - ${p.name} — Rp${p.price}\n` );
  await ctx.reply(text);
});

bot.action('stats', async (ctx) => {
  if (ctx.from.id !== config.admin_id) return ctx.answerCbQuery('Hanya admin.');
  const users = utils.read(USERS_FILE).length;
  const products = utils.read(PRODUCTS_FILE).length;
  const orders = utils.read(ORDERS_FILE).length;
  await ctx.reply(`📊 Statistik:\nUsers: ${users}\nProducts: ${products}\nOrders: ${orders}`);
});

bot.launch().then(()=>console.log('✅ Kyu Store v3.2 berjalan...')).catch(e=>console.error('launch err', e));
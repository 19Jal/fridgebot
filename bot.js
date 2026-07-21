const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  downloadMediaMessage,
} = require('baileys')
const qrcode = require('qrcode-terminal')
const fs = require('fs')

// ============ CONFIG ============
const STORE = 'items.json'
const MEDIA_DIR = 'media'
const { groupJid: GROUP_JID } = (() => {
  try { return JSON.parse(fs.readFileSync('groupID.json', 'utf8')) }
  catch { throw new Error("Missing groupID.json — copy groupID.example.json to groupID.json and fill in your group's JID") }
})()
const SHELF_DAYS = 5                         // days until an item is due
const RETAIN_DAYS = 30                       // how long notified items stay (dedupe safety)
const TZ_OFFSET_MS = 8 * 3600 * 1000         // Taipei = fixed UTC+8, no DST
const CHECK_INTERVAL_MS = 5 * 60 * 1000      // how often the scheduler wakes
// ================================

fs.mkdirSync(MEDIA_DIR, { recursive: true })

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// --- tiny JSON store ---
const loadItems = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return [] } }
const saveItems = (items) => fs.writeFileSync(STORE, JSON.stringify(items, null, 2))
const alreadyLogged = (msgId) => loadItems().some(i => i.messageKey?.id === msgId)

// drop old notified items + their photos; NEVER drop pending ones
function pruneItems() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000
  const items = loadItems()
  const kept = items.filter(i => !i.notified || i.storedAt > cutoff)
  if (kept.length === items.length) return

  for (const i of items) {
    if (kept.includes(i)) continue
    if (i.mediaPath) { try { fs.unlinkSync(i.mediaPath) } catch {} }
  }
  saveItems(kept)
  console.log(`Pruned ${items.length - kept.length} old items`)
}

// --- chat type helpers ---
const isGroup = (jid) => jid.endsWith('@g.us')
const isDM    = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')

// --- Taipei date helpers (offset trick valid ONLY because Taipei never uses DST) ---
const taipei = (ms) => { const t = new Date(ms + TZ_OFFSET_MS); return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() } }
const labelFull  = (ms) => { const p = taipei(ms); return `${WEEKDAYS[p.wd]} ${MONTHS[p.mo]} ${p.d}` }
const labelShort = (ms) => { const p = taipei(ms); return `${MONTHS[p.mo]} ${p.d}` }

// dig the real imageMessage out of viewOnce / ephemeral wrappers
const unwrap = (msg) => {
  if (!msg) return msg
  if (msg.ephemeralMessage)  return unwrap(msg.ephemeralMessage.message)
  if (msg.viewOnceMessage)   return unwrap(msg.viewOnceMessage.message)
  if (msg.viewOnceMessageV2) return unwrap(msg.viewOnceMessageV2.message)
  return msg
}

// --- reminder: announce in the group AND DM the owner, both with the photo ---
async function fireReminder(sock, item) {
  const text =
    `⏰ Take out reminder: this item (stored ${labelShort(item.storedAt)}) ` +
    `is due today, ${labelShort(item.dueAt)}. Please remove it from the fridge.`

  // attach the saved photo if we have it; fall back to plain text if not
  const payload = (caption) => {
    if (item.mediaPath && fs.existsSync(item.mediaPath)) {
      return { image: fs.readFileSync(item.mediaPath), caption }
    }
    return { text: caption }
  }

  // --- 1. group announcement (always, even for DM-stored items) ---
  const groupJid = isGroup(item.chatId) ? item.chatId : GROUP_JID

  let mentions = []
  try {
    const me = jidNormalizedUser(sock.user.id)
    const meLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null
    const meta = await sock.groupMetadata(groupJid)
    mentions = meta.participants
      .map(p => p.id)
      .filter(jid => {
        const norm = jidNormalizedUser(jid)
        return norm !== me && norm !== meLid      // don't tag the bot itself
      })
  } catch (e) {
    console.log('Could not fetch group members:', e?.message)
  }

  // only quote if the original message actually lives in this chat
  const opts = (item.chatId === groupJid)
    ? { quoted: { key: item.messageKey, message: { imageMessage: {} } } }
    : {}

  await sock.sendMessage(groupJid, { ...payload(text), mentions }, opts)

  // --- 2. private DM to the owner (isolated: a DM failure must not undo the group send) ---
  if (item.sender) {
    const dmText =
      `⏰ Private reminder: your fridge item (stored ${labelShort(item.storedAt)}) ` +
      `is due today, ${labelShort(item.dueAt)}. Please remove it.`
    try {
      await sock.sendMessage(item.sender, payload(dmText))
      console.log('DM sent to owner', item.sender)
    } catch (e) {
      console.log('Owner DM failed for', item.sender, '-', e?.message)
    }
  }
}

// --- scheduler: reads the file, fires anything due, marks it sent (restart-proof) ---
async function checkDue(sock) {
  const now = Date.now()
  const items = loadItems()
  let changed = false

  for (const item of items) {
    if (item.done || item.notified) continue
    if (item.dueAt <= now) {
      try {
        await fireReminder(sock, item)
        item.notified = true
        changed = true
        console.log('Reminder fired for item', item.id)
      } catch (e) {
        console.log('Failed to send reminder for', item.id, e?.message)
        // leave notified=false so it retries next tick
      }
    }
  }

  if (changed) saveItems(items)
  pruneItems()          // must run AFTER saveItems — both touch the same file
}

// module-level so reconnects reuse ONE scheduler instead of stacking a new
// setInterval on every reconnect (each bound to whatever `sock` existed at the time)
let sock = null
let isConnected = false
let reconnectDelayMs = 2000
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestWaWebVersion()   // keep: stale version = "couldn't link device"
  sock = makeWASocket({ version, auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === 'open') {
      console.log('✅ FridgeBot connected')
      isConnected = true
      reconnectDelayMs = 2000   // reset backoff after a clean connect
      return
    }
    if (connection === 'close') {
      isConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // exit (don't just idle) so pm2/the process supervisor surfaces this as
        // down instead of silently running "online" while fully non-functional
        console.log('⚠️  Logged out — delete the auth/ folder and re-scan. Exiting.')
        process.exit(1)
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log('⚠️  Replaced by another session — another copy is running. Exiting.')
        process.exit(1)   // never reconnect here, or you get an infinite fight
      }
      console.log(`Connection closed (${code}), reconnecting in ${reconnectDelayMs / 1000}s...`)
      setTimeout(reconnect, reconnectDelayMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const me = jidNormalizedUser(sock.user.id)
    const meLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null

    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue
      if (alreadyLogged(m.key.id)) continue             // dedupe by message id

      const chatId = m.key.remoteJid
      if (!isGroup(chatId) && !isDM(chatId)) continue   // blocks status@broadcast, newsletters

      const content = unwrap(m.message)
      const img = content?.imageMessage
      if (!img) continue                                // must contain a photo

      // groups require an @mention; DMs don't (the whole chat is the bot)
      if (isGroup(chatId)) {
        const mentioned = img.contextInfo?.mentionedJid || []
        if (!mentioned.includes(me) && !(meLid && mentioned.includes(meLid))) continue
      }

      // --- valid store event ---
      const tsRaw = m.messageTimestamp
      const tsSec = typeof tsRaw === 'number' ? tsRaw : (tsRaw?.toNumber?.() ?? 0)
      const storedAt = tsSec ? tsSec * 1000 : Date.now()   // sender's time, not processing time

      // save the photo now — WhatsApp media URLs expire, local files don't
      let mediaPath = null
      try {
        const buf = await downloadMediaMessage(m, 'buffer', {})
        mediaPath = `${MEDIA_DIR}/${m.key.id}.jpg`
        fs.writeFileSync(mediaPath, buf)
      } catch (e) {
        console.log('Media download failed:', e?.message)  // non-fatal: reminder falls back to text
      }

      const s = taipei(storedAt)
      const dueAt = Date.UTC(s.y, s.mo, s.d + SHELF_DAYS, 0, 0, 0)  // 08:00 Taipei on day+5

      const items = loadItems()
      items.push({
        id: Date.now(),
        storedAt,
        dueAt,
        chatId,
        sender: m.key.participant || m.key.remoteJid,   // participant is undefined in DMs
        senderName: m.pushName || 'someone',
        messageKey: m.key,
        mediaPath,
        done: false,
      })
      saveItems(items)

      const reply = `Item stored on ${labelFull(storedAt)}. Take out reminder set: ${labelShort(dueAt)}.`
      await sock.sendMessage(chatId, { text: reply }, { quoted: m })
      console.log('Logged item in', isGroup(chatId) ? 'group' : 'DM', chatId, '— due', new Date(dueAt).toISOString())
    }
  })

}

// retry startup itself (e.g. a transient failure in fetchLatestWaWebVersion)
// instead of an unhandled rejection killing the process
function reconnect() {
  start().catch((e) => {
    console.log(`Startup failed (${e?.message}), retrying in ${reconnectDelayMs / 1000}s...`)
    setTimeout(reconnect, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
  })
}

// module-level scheduler: set up ONCE for the process lifetime so reconnects
// don't stack a new setInterval on top of the old one every time; skips the
// tick entirely while disconnected instead of throwing "Connection Closed"
// on every item, every 5 minutes, forever
function scheduledCheckDue() {
  if (!isConnected || !sock) { console.log('Skipping reminder check — not connected'); return }
  checkDue(sock)
}
setTimeout(scheduledCheckDue, 10000)                  // catch up ~10s after connecting
setInterval(scheduledCheckDue, CHECK_INTERVAL_MS)     // then every 5 min

reconnect()
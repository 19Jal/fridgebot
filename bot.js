const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
} = require('baileys')
const qrcode = require('qrcode-terminal')
const fs = require('fs')

const STORE = 'items.json'
const SHELF_DAYS = 5
const TZ_OFFSET_MS = 8 * 3600 * 1000 // Taipei is a fixed UTC+8, no DST — makes the math clean

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// --- tiny JSON store ---
const loadItems = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return [] } }
const saveItems = (items) => fs.writeFileSync(STORE, JSON.stringify(items, null, 2))

// --- Taipei date helpers (offset trick is valid ONLY because Taipei = fixed UTC+8) ---
const taipei = (ms) => { const t = new Date(ms + TZ_OFFSET_MS); return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() } }
const labelFull  = (ms) => { const p = taipei(ms); return `${WEEKDAYS[p.wd]} ${MONTHS[p.mo]} ${p.d}` }
const labelShort = (ms) => { const p = taipei(ms); return `${MONTHS[p.mo]} ${p.d}` }

// unwrap viewOnce / ephemeral wrappers so we can see the real imageMessage
const unwrap = (msg) => {
  if (!msg) return msg
  if (msg.ephemeralMessage)  return unwrap(msg.ephemeralMessage.message)
  if (msg.viewOnceMessage)   return unwrap(msg.viewOnceMessage.message)
  if (msg.viewOnceMessageV2) return unwrap(msg.viewOnceMessageV2.message)
  return msg
}

// --- reminder sender: posts to the group, quotes the original photo, @all ---
async function fireReminder(sock, item) {
  const me = jidNormalizedUser(sock.user.id)
  const meLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null

  let mentions = []
  try {
    const meta = await sock.groupMetadata(item.chatId)
    mentions = meta.participants
      .map(p => p.id)
      .filter(jid => {
        const norm = jidNormalizedUser(jid)
        return norm !== me && norm !== meLid
      })
  } catch (e) {
    console.log('Could not fetch group members:', e?.message)
  }

  const text =
    `⏰ Take out reminder: this item (stored ${labelShort(item.storedAt)}) ` +
    `is due today, ${labelShort(item.dueAt)}. Please remove it from the fridge.`

  await sock.sendMessage(
    item.chatId,
    { text, mentions },   // everyone is in the array (→ notified), but no @tokens shown
    { quoted: { key: item.messageKey, message: { imageMessage: {} } } }
  )
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
        // leave notified=false so it retries on the next tick
      }
    }
  }

  if (changed) saveItems(items)
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestWaWebVersion()
  const sock = makeWASocket({ version, auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === 'open') { console.log('✅ FridgeBot connected'); return }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out — delete the auth/ folder and re-scan.')
        return
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log('⚠️  Replaced by another session — another copy is running. Exiting.')
        process.exit(1)
      }
      console.log('Connection closed, reconnecting...', code)
      start()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const me = jidNormalizedUser(sock.user.id)
    const meLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null

    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue
      const chatId = m.key.remoteJid
      if (!chatId.endsWith('@g.us')) continue

      const content = unwrap(m.message)
      const img = content?.imageMessage
      if (!img) continue

      const mentioned = img.contextInfo?.mentionedJid || []
      console.log('DEBUG mentions:', mentioned, '| me:', me, '| meLid:', meLid)
      if (!mentioned.includes(me) && !(meLid && mentioned.includes(meLid))) continue

      // --- valid store event ---
      const tsRaw = m.messageTimestamp
      const tsSec = typeof tsRaw === 'number' ? tsRaw : (tsRaw?.toNumber?.() ?? 0)
      const storedAt = tsSec ? tsSec * 1000 : Date.now()

      const s = taipei(storedAt)
      const dueAt = Date.UTC(s.y, s.mo, s.d + SHELF_DAYS, 0, 0, 0) // = 08:00 Taipei on day+SHELF_DAYS
      // const dueAt = Date.now() + 60 * 1000   // TEST: due in 1 minute

      const items = loadItems()
      items.push({
        id: Date.now(),
        storedAt,
        dueAt,
        chatId,
        sender: m.key.participant,
        senderName: m.pushName || 'someone',
        messageKey: m.key,
        done: false,
      })
      saveItems(items)

      const reply = `Item stored on ${labelFull(storedAt)}. Take out reminder set: ${labelShort(dueAt)}.`
      await sock.sendMessage(chatId, { text: reply }, { quoted: m })
      console.log('Logged item, due', new Date(dueAt).toISOString())
    }
  })

  // --- scheduler wiring (inside start, where sock exists) ---
  setTimeout(() => checkDue(sock), 10000)          // run once ~10s after connecting
  setInterval(() => checkDue(sock), 10 * 1000)     // TEST: every 10s (revert to 5*60*1000 later)
}

start()
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys')
const qrcode = require('qrcode-terminal')

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({ auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) qrcode.generate(qr, { small: true })        // prints the QR
    if (connection === 'open') {
      console.log('✅ Linked and connected as FridgeBot')
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      console.log('Connection closed. Logged out:', loggedOut)
      if (!loggedOut) start()                           // auto-reconnect
    }
  })
}

start()
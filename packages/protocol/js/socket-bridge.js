// Direct Sockets → POSIX socket emulation for Emscripten ASYNCIFY.
// The WASM module calls these JS functions (listed in ASYNCIFY_IMPORTS)
// instead of the native POSIX socket calls.
// Each function returns a Promise; ASYNCIFY suspends the WASM fiber until resolved.

// Maps fd → { tcp: TcpTransport } | { udp: UdpTransport }
const sockets = new Map()
let nextFd = 100

mergeInto(LibraryManager.library, {
  // Called by the C platform layer instead of socket() + connect()
  socket_connect__async: true,
  socket_connect: async function(hostPtr, port, isUdp) {
    const host = UTF8ToString(hostPtr)
    const fd = nextFd++
    if (isUdp) {
      const { UdpTransport } = await import('../../../apps/iwa/src/transport/udp.ts')
      const udp = await UdpTransport.create({ remoteAddress: host, remotePort: port })
      sockets.set(fd, { udp })
    } else {
      const { TcpTransport } = await import('../../../apps/iwa/src/transport/tcp.ts')
      const tcp = await TcpTransport.connect(host, port)
      sockets.set(fd, { tcp })
    }
    return fd
  },

  socket_send__async: true,
  socket_send: async function(fd, dataPtr, length) {
    const sock = sockets.get(fd)
    if (!sock?.tcp) return -1
    const data = HEAPU8.slice(dataPtr, dataPtr + length)
    await sock.tcp.send(data)
    return length
  },

  socket_recv__async: true,
  socket_recv: async function(fd, bufPtr, maxLength) {
    const sock = sockets.get(fd)
    if (!sock?.tcp) return -1
    const data = await sock.tcp.readExact(maxLength)
    HEAPU8.set(data, bufPtr)
    return data.length
  },

  socket_sendto__async: true,
  socket_sendto: async function(fd, dataPtr, length, hostPtr, port) {
    const sock = sockets.get(fd)
    if (!sock?.udp) return -1
    const data = HEAPU8.slice(dataPtr, dataPtr + length)
    const host = hostPtr ? UTF8ToString(hostPtr) : undefined
    await sock.udp.send(data, host, port || undefined)
    return length
  },

  socket_recvfrom__async: true,
  socket_recvfrom: async function(fd, bufPtr, maxLength) {
    const sock = sockets.get(fd)
    if (!sock?.udp) return -1
    const pkt = await sock.udp.receive()
    const len = Math.min(pkt.data.length, maxLength)
    HEAPU8.set(pkt.data.slice(0, len), bufPtr)
    return len
  },

  socket_close: function(fd) {
    const sock = sockets.get(fd)
    if (!sock) return
    sock.tcp?.close().catch(() => {})
    sock.udp?.close().catch(() => {})
    sockets.delete(fd)
  },
})

import type { MoonlightRuntimeTransport, TcpHandle, TransportFactory, UdpHandle } from './types.js'

type SocketEntry =
  | { kind: 'tcp'; handle: TcpHandle }
  | { kind: 'udp'; handle: UdpHandle }

const FIRST_SYNTHETIC_FD = 100
const DEBUG_ENDPOINT = 'http://127.0.0.1:7458/ingest/a70defe2-9a92-40ab-8b63-4a3e87de3fac'

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '31fcc6' },
    body: JSON.stringify({
      sessionId: '31fcc6',
      runId: 'rtsp-transport',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion
}

export function createRuntimeTransport(factory: TransportFactory): MoonlightRuntimeTransport {
  const sockets = new Map<number, SocketEntry>()
  let nextFd = FIRST_SYNTHETIC_FD

  const register = (entry: SocketEntry): number => {
    const fd = nextFd++
    sockets.set(fd, entry)
    return fd
  }

  return {
    async connect(host, port, socketType) {
      debugLog('H18', 'packages/protocol/src/transport.ts:connect', 'Runtime transport connect requested', {
        host,
        port,
        socketType,
      })
      try {
        let fd: number
        if (socketType === 'udp') {
          fd = register({
            kind: 'udp',
            handle: await factory.createUdp({ remoteAddress: host, remotePort: port }),
          })
        } else {
          fd = register({ kind: 'tcp', handle: await factory.connectTcp(host, port) })
        }
        debugLog('H18', 'packages/protocol/src/transport.ts:connect', 'Runtime transport connect succeeded', {
          host,
          port,
          socketType,
          fd,
        })
        return fd
      } catch (err) {
        debugLog('H18', 'packages/protocol/src/transport.ts:connect', 'Runtime transport connect failed', {
          host,
          port,
          socketType,
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : typeof err,
        })
        throw err
      }
    },

    async bindUdp(localPort) {
      const options: { localPort?: number } = {}
      if (localPort !== undefined) options.localPort = localPort
      // #region agent log
      debugLog('H30,H31,H32', 'packages/protocol/src/transport.ts:bindUdp', 'Runtime transport bindUdp requested', {
        localPort: localPort ?? null,
      })
      // #endregion
      try {
        const handle = await factory.createUdp(options)
        const fd = register({ kind: 'udp', handle })
        // #region agent log
        debugLog('H30,H31,H32', 'packages/protocol/src/transport.ts:bindUdp', 'Runtime transport bindUdp succeeded', {
          localPort: localPort ?? null,
          fd,
        })
        // #endregion
        return fd
      } catch (err) {
        // #region agent log
        debugLog('H30,H31,H32', 'packages/protocol/src/transport.ts:bindUdp', 'Runtime transport bindUdp failed', {
          localPort: localPort ?? null,
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : typeof err,
        })
        // #endregion
        throw err
      }
    },

    async send(fd, data) {
      const socket = sockets.get(fd)
      if (socket?.kind !== 'tcp') return -1
      debugLog('H19', 'packages/protocol/src/transport.ts:send', 'Runtime transport TCP send requested', {
        fd,
        length: data.length,
      })
      try {
        await socket.handle.send(data)
        debugLog('H19', 'packages/protocol/src/transport.ts:send', 'Runtime transport TCP send succeeded', {
          fd,
          length: data.length,
        })
        return data.length
      } catch (err) {
        debugLog('H19', 'packages/protocol/src/transport.ts:send', 'Runtime transport TCP send failed', {
          fd,
          length: data.length,
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : typeof err,
        })
        throw err
      }
    },

    async recv(fd, length) {
      const socket = sockets.get(fd)
      if (socket?.kind !== 'tcp') return new Uint8Array()
      debugLog('H20', 'packages/protocol/src/transport.ts:recv', 'Runtime transport TCP recv requested', {
        fd,
        length,
      })
      try {
        const data = await socket.handle.readAvailable(length)
        debugLog('H20', 'packages/protocol/src/transport.ts:recv', 'Runtime transport TCP recv succeeded', {
          fd,
          requestedLength: length,
          actualLength: data.length,
          closed: data.length === 0,
        })
        return data
      } catch (err) {
        debugLog('H20', 'packages/protocol/src/transport.ts:recv', 'Runtime transport TCP recv failed', {
          fd,
          length,
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : typeof err,
        })
        throw err
      }
    },

    async sendTo(fd, data, host, port) {
      const socket = sockets.get(fd)
      if (socket?.kind !== 'udp') return -1
      // #region agent log
      debugLog('H40', 'packages/protocol/src/transport.ts:sendTo', 'Runtime transport UDP sendTo (ENet/AV)', {
        fd,
        length: data.length,
        host: host ?? null,
        port: port ?? null,
      })
      // #endregion
      await socket.handle.send(data, host, port)
      return data.length
    },

    async recvFrom(fd, length) {
      const socket = sockets.get(fd)
      if (socket?.kind !== 'udp') return new Uint8Array()
      const packet = await socket.handle.receive()
      return packet.data.slice(0, length)
    },

    async recvFromTimed(fd, length, timeoutMs) {
      const socket = sockets.get(fd)
      if (socket?.kind !== 'udp') return new Uint8Array()
      const packet = await socket.handle.receiveTimed(timeoutMs)
      if (!packet) return new Uint8Array()
      // #region agent log
      debugLog('H40', 'packages/protocol/src/transport.ts:recvFromTimed', 'Runtime transport UDP datagram received (ENet)', {
        fd,
        length: packet.data.length,
        timeoutMs,
        from: packet.remoteAddress,
        fromPort: packet.remotePort,
      })
      // #endregion
      return packet.data.slice(0, length)
    },

    close(fd) {
      const socket = sockets.get(fd)
      if (!socket) return
      sockets.delete(fd)
      debugLog('H21', 'packages/protocol/src/transport.ts:close', 'Runtime transport socket closed', {
        fd,
        kind: socket.kind,
      })
      void socket.handle.close()
    },
  }
}

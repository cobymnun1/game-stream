// ENet socket layer for the browser/WASM build.
//
// moonlight-common-c bundles ENet (enet/unix.c) which talks to raw BSD
// sockets. Those don't reach the Sunshine host inside a browser, so the
// control stream (ENet over UDP) would time out. We keep the rest of ENet
// (protocol, address helpers, timing) intact and replace only the socket I/O
// via the linker's --wrap option, routing it through the Direct Sockets
// bridge (socket_bind_udp / socket_sendto / enet_udp_recv).
//
// moonlight's control client uses exactly one ENet host with one peer, and
// this ENet fork has its received-address check disabled (protocol.c), so we
// can reuse the last send target as the receive peer address and keep a single
// pending-datagram slot shared between enet_socket_wait and the following
// enet_socket_receive.

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define ENET_BUILDING_LIB 1
#include "enet/enet.h"

extern int socket_bind_udp(int local_port);
extern int socket_sendto(int fd, const char* data, int length, const char* host, int port);
extern int enet_udp_recv(int fd, char* data, int length, int timeout_ms);
extern void socket_close(int fd);
extern const char* webHostFromSockaddr(const struct sockaddr_storage* addr);

#define ENET_WEB_DATAGRAM_MAX 4096 /* ENET_PROTOCOL_MAXIMUM_MTU */

// Single datagram captured by enet_socket_wait and consumed by the next
// enet_socket_receive call on the same socket.
static enet_uint8 pendingData[ENET_WEB_DATAGRAM_MAX];
static int pendingLength = -1;
static ENetSocket pendingSocket = ENET_SOCKET_NULL;

// The control peer's address, remembered from the most recent send.
static ENetAddress peerAddr;
static bool hasPeer = false;

static int hostPortFromAddress(const ENetAddress* address, const char** hostOut) {
  *hostOut = webHostFromSockaddr(&address->address);
  if (address->address.ss_family == AF_INET) {
    return ntohs(((const struct sockaddr_in*)&address->address)->sin_port);
  }
  return 0;
}

static void fillPeerAddress(ENetAddress* peerAddress) {
  if (peerAddress != NULL && hasPeer) {
    *peerAddress = peerAddr;
  }
}

ENetSocket __wrap_enet_socket_create(int af, ENetSocketType type) {
  (void)af;
  if (type != ENET_SOCKET_TYPE_DATAGRAM) {
    return ENET_SOCKET_NULL;
  }
  int fd = socket_bind_udp(0);
  return fd < 0 ? ENET_SOCKET_NULL : (ENetSocket)fd;
}

void __wrap_enet_socket_destroy(ENetSocket socket) {
  if (socket == ENET_SOCKET_NULL) {
    return;
  }
  if (pendingSocket == socket) {
    pendingLength = -1;
    pendingSocket = ENET_SOCKET_NULL;
  }
  socket_close(socket);
}

// The UDP socket is already bound to an ephemeral port at create time.
int __wrap_enet_socket_bind(ENetSocket socket, const ENetAddress* address) {
  (void)socket;
  (void)address;
  return 0;
}

// Caller keeps the local address it passed to enet_host_create.
int __wrap_enet_socket_get_address(ENetSocket socket, ENetAddress* address) {
  (void)socket;
  (void)address;
  return -1;
}

int __wrap_enet_socket_set_option(ENetSocket socket, ENetSocketOption option, int value) {
  (void)socket;
  (void)option;
  (void)value;
  return 0;
}

int __wrap_enet_socket_get_option(ENetSocket socket, ENetSocketOption option, int* value) {
  (void)socket;
  if (option == ENET_SOCKOPT_ERROR && value != NULL) {
    *value = 0;
  }
  return 0;
}

// Connectionless UDP; each send targets the peer address explicitly.
int __wrap_enet_socket_connect(ENetSocket socket, const ENetAddress* address) {
  (void)socket;
  (void)address;
  return 0;
}

int __wrap_enet_socket_shutdown(ENetSocket socket, ENetSocketShutdown how) {
  (void)socket;
  (void)how;
  return 0;
}

int __wrap_enet_socket_send(ENetSocket socket,
                            const ENetAddress* peerAddress,
                            const ENetAddress* localAddress,
                            const ENetBuffer* buffers,
                            size_t bufferCount) {
  (void)localAddress;

  if (peerAddress != NULL) {
    peerAddr = *peerAddress;
    hasPeer = true;
  }

  // Coalesce the scatter/gather buffers into a single datagram.
  static enet_uint8 sendBuffer[ENET_WEB_DATAGRAM_MAX];
  size_t total = 0;
  for (size_t i = 0; i < bufferCount; i++) {
    if (total + buffers[i].dataLength > sizeof(sendBuffer)) {
      return -1;
    }
    memcpy(sendBuffer + total, buffers[i].data, buffers[i].dataLength);
    total += buffers[i].dataLength;
  }

  const char* host = NULL;
  int port = peerAddress != NULL ? hostPortFromAddress(peerAddress, &host) : 0;
  if (host == NULL) {
    return -1;
  }

  int sent = socket_sendto(socket, (const char*)sendBuffer, (int)total, host, port);
  return sent < 0 ? -1 : (int)total;
}

int __wrap_enet_socket_receive(ENetSocket socket,
                               ENetAddress* peerAddress,
                               ENetAddress* localAddress,
                               ENetBuffer* buffers,
                               size_t bufferCount) {
  (void)localAddress;
  if (bufferCount == 0) {
    return 0;
  }

  // Hand back the datagram captured by the preceding enet_socket_wait.
  if (pendingLength >= 0 && pendingSocket == socket) {
    int copyLen = pendingLength;
    if ((size_t)copyLen > buffers[0].dataLength) {
      copyLen = (int)buffers[0].dataLength;
    }
    memcpy(buffers[0].data, pendingData, copyLen);
    pendingLength = -1;
    pendingSocket = ENET_SOCKET_NULL;
    fillPeerAddress(peerAddress);
    return copyLen;
  }

  // Otherwise drain any further queued datagrams non-blocking (timeout 0).
  int received = enet_udp_recv(socket, (char*)buffers[0].data, (int)buffers[0].dataLength, 0);
  if (received <= 0) {
    return received < 0 ? -1 : 0;
  }
  fillPeerAddress(peerAddress);
  return received;
}

int __wrap_enet_socket_wait(ENetSocket socket, enet_uint32* condition, enet_uint32 timeout) {
  enet_uint32 requested = *condition;
  *condition = ENET_SOCKET_WAIT_NONE;

  // UDP is always writable.
  if (requested & ENET_SOCKET_WAIT_SEND) {
    *condition |= ENET_SOCKET_WAIT_SEND;
  }

  if (!(requested & ENET_SOCKET_WAIT_RECEIVE)) {
    return 0;
  }

  if (pendingLength >= 0 && pendingSocket == socket) {
    *condition |= ENET_SOCKET_WAIT_RECEIVE;
    return 0;
  }

  int received = enet_udp_recv(socket, (char*)pendingData, (int)sizeof(pendingData), (int)timeout);
  if (received < 0) {
    return -1;
  }
  if (received > 0) {
    pendingLength = received;
    pendingSocket = socket;
    *condition |= ENET_SOCKET_WAIT_RECEIVE;
  }
  return 0;
}

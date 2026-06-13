#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "PlatformSockets.h"

#define MAX_WEB_HOSTS 256
#define MAX_WEB_HOST_LENGTH 256
#define SYNTHETIC_HOST_PREFIX 0x0A000000u

extern int socket_connect(const char* host, int port, int is_udp);
extern int socket_bind_udp(int local_port);
extern int socket_send(int fd, const char* data, int length);
extern int socket_recv(int fd, char* data, int length);
extern int socket_sendto(int fd, const char* data, int length, const char* host, int port);
extern int socket_recvfrom(int fd, char* data, int length);
extern void socket_close(int fd);

static char host_names[MAX_WEB_HOSTS][MAX_WEB_HOST_LENGTH];
static int next_host_id = 1;

static int remember_host(const char* host) {
  for (int i = 1; i < next_host_id; i++) {
    if (strncmp(host_names[i], host, MAX_WEB_HOST_LENGTH) == 0) {
      return i;
    }
  }

  if (next_host_id >= MAX_WEB_HOSTS) {
    return -1;
  }

  int id = next_host_id++;
  snprintf(host_names[id], MAX_WEB_HOST_LENGTH, "%s", host);
  return id;
}

static int host_id_from_addr(const struct sockaddr_storage* addr) {
  if (addr == NULL || addr->ss_family != AF_INET) {
    return -1;
  }

  const struct sockaddr_in* sin = (const struct sockaddr_in*)addr;
  uint32_t encoded = ntohl(sin->sin_addr.s_addr);
  if ((encoded & 0xFF000000u) != SYNTHETIC_HOST_PREFIX) {
    return -1;
  }

  return (int)(encoded & 0x000000FFu);
}

static const char* host_from_addr(const struct sockaddr_storage* addr) {
  int id = host_id_from_addr(addr);
  if (id <= 0 || id >= next_host_id) {
    return NULL;
  }
  return host_names[id];
}

// Exposed for the ENet web socket shim (enet_web.c), which needs to translate
// the synthetic sockaddr peer address back into the original host string.
const char* webHostFromSockaddr(const struct sockaddr_storage* addr) {
  return host_from_addr(addr);
}

void addrToUrlSafeString(struct sockaddr_storage* addr, char* string, size_t stringLength) {
  const char* host = host_from_addr(addr);
  if (host != NULL) {
    snprintf(string, stringLength, "%s", host);
    return;
  }

  snprintf(string, stringLength, "0.0.0.0");
}

void shutdownTcpSocket(SOCKET s) {
  socket_close(s);
}

int setNonFatalRecvTimeoutMs(SOCKET s, int timeoutMs) {
  (void)s;
  (void)timeoutMs;
  return 0;
}

int pollSockets(struct pollfd* pollFds, int pollFdsCount, int timeoutMs) {
  (void)timeoutMs;
  int ready = 0;
  for (int i = 0; i < pollFdsCount; i++) {
    pollFds[i].revents = pollFds[i].events;
    ready++;
  }
  return ready;
}

bool isSocketReadable(SOCKET s) {
  (void)s;
  return true;
}

int recvUdpSocket(SOCKET s, char* buffer, int size, bool useSelect) {
  (void)useSelect;
  return socket_recvfrom(s, buffer, size);
}

void closeSocket(SOCKET s) {
  socket_close(s);
}

SOCKET bindUdpSocket(int addressFamily, struct sockaddr_storage* localAddr, SOCKADDR_LEN addrLen,
  int bufferSize, int socketQosType) {
  (void)addressFamily;
  (void)addrLen;
  (void)bufferSize;
  (void)socketQosType;

  int local_port = 0;
  if (localAddr != NULL && localAddr->ss_family == AF_INET) {
    local_port = ntohs(((struct sockaddr_in*)localAddr)->sin_port);
  }

  return socket_bind_udp(local_port);
}

int setSocketNonBlocking(SOCKET s, bool enabled) {
  (void)s;
  (void)enabled;
  return 0;
}

SOCKET createSocket(int addressFamily, int socketType, int protocol, bool nonBlocking) {
  (void)addressFamily;
  (void)protocol;
  (void)nonBlocking;

  if (socketType == SOCK_DGRAM) {
    return socket_bind_udp(0);
  }

  return INVALID_SOCKET;
}

SOCKET connectTcpSocket(struct sockaddr_storage* dstaddr, SOCKADDR_LEN addrlen, unsigned short port,
  int timeoutSec) {
  (void)addrlen;
  (void)timeoutSec;

  const char* host = host_from_addr(dstaddr);
  if (host == NULL) {
    return INVALID_SOCKET;
  }

  return socket_connect(host, port, 0);
}

int getLocalAddressByUdpConnect(const struct sockaddr_storage* targetAddr, SOCKADDR_LEN targetAddrLen,
  unsigned short targetPort, struct sockaddr_storage* localAddr, SOCKADDR_LEN* localAddrLen) {
  (void)targetAddr;
  (void)targetAddrLen;
  (void)targetPort;

  if (localAddr != NULL) {
    memset(localAddr, 0, sizeof(*localAddr));
    struct sockaddr_in* sin = (struct sockaddr_in*)localAddr;
    sin->sin_family = AF_INET;
    sin->sin_port = 0;
    sin->sin_addr.s_addr = htonl(INADDR_ANY);
  }

  if (localAddrLen != NULL) {
    *localAddrLen = sizeof(struct sockaddr_in);
  }

  return 0;
}

int sendMtuSafe(SOCKET s, char* buffer, int size) {
  int sent = socket_send(s, buffer, size);
  if (sent >= 0) {
    return sent;
  }

  return socket_sendto(s, buffer, size, NULL, 0);
}

// moonlight's RTSP code calls libc recv() directly on our synthetic socket
// descriptors, which Emscripten's libc does not know about. Route it through
// the JS Direct Sockets bridge via the linker's --wrap=recv option.
ssize_t __wrap_recv(SOCKET s, void* buf, size_t len, int flags) {
  (void)flags;
  return socket_recv(s, (char*)buf, (int)len);
}

// moonlight's video/audio UDP "ping" threads call libc sendto() directly on
// our synthetic UDP descriptors to tell the host where to stream. Emscripten's
// libc has no such socket, so the raw call fails (-1) and the host never sends
// video/audio. Route it through the Direct Sockets bridge via --wrap=sendto,
// decoding the synthetic destination address back into the original host:port.
ssize_t __wrap_sendto(SOCKET s, const void* buf, size_t len, int flags,
  const struct sockaddr* dest_addr, socklen_t addrlen) {
  (void)flags;
  (void)addrlen;

  const char* host = NULL;
  int port = 0;
  if (dest_addr != NULL && dest_addr->sa_family == AF_INET) {
    const struct sockaddr_in* sin = (const struct sockaddr_in*)dest_addr;
    port = ntohs(sin->sin_port);
    host = webHostFromSockaddr((const struct sockaddr_storage*)dest_addr);
  }

  return socket_sendto(s, (const char*)buf, (int)len, host, port);
}

int enableNoDelay(SOCKET s) {
  (void)s;
  return 0;
}

int resolveHostName(const char* host, int family, int tcpTestPort, struct sockaddr_storage* addr,
  SOCKADDR_LEN* addrLen) {
  (void)family;
  (void)tcpTestPort;

  int id = remember_host(host);
  if (id < 0 || addr == NULL || addrLen == NULL) {
    return -1;
  }

  memset(addr, 0, sizeof(*addr));
  struct sockaddr_in* sin = (struct sockaddr_in*)addr;
  sin->sin_family = AF_INET;
  sin->sin_addr.s_addr = htonl(SYNTHETIC_HOST_PREFIX | (uint32_t)id);
  *addrLen = sizeof(struct sockaddr_in);
  return 0;
}

bool isPrivateNetworkAddress(struct sockaddr_storage* address) {
  (void)address;
  return false;
}

bool isNat64SynthesizedAddress(struct sockaddr_storage* address) {
  (void)address;
  return false;
}

void enterLowLatencyMode(void) {}

void exitLowLatencyMode(void) {}

int initializePlatformSockets(void) {
  return 0;
}

void cleanupPlatformSockets(void) {}

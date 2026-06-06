export const SUNSHINE_TCP_PORTS = [47984, 47989, 47990, 48010] as const;
export const SUNSHINE_UDP_PORTS = [47998, 47999, 48000, 48002, 48010] as const;

export const SUNSHINE_READY_REGEX =
  /SUNSHINE_READY\s+user[=:](\S+)\s+pass[=:](\S+)/i;

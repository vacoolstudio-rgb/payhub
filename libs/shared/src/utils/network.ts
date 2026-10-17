import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Address ranges a merchant webhook must never reach.
 *
 * A webhook URL is attacker-chosen: the merchant says where we send a
 * signed POST, and our workers sit inside the network. Pointed at
 * `169.254.169.254` it fetches cloud credentials; pointed at an internal
 * service it reaches something that trusts its callers because they are
 * inside.
 *
 * The first version of this check matched a dotted-quad with a regular
 * expression, so every IPv6 literal fell straight through — `https://[::1]/`
 * and `https://[fd00::1]/` were both accepted.
 */

/** Blocked IPv4 ranges, as [first octet, predicate on the rest]. */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = octets as [number, number, number, number];

  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC 6598 carrier NAT
    (a === 169 && b === 254) || // link-local, incl. the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && b >= 18 && b <= 19) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * IPv6, by expanding the literal into its eight groups rather than
 * pattern-matching the text. `fd00::1` and `fd00:0:0:0:0:0:0:1` are the
 * same address and must give the same answer.
 */
function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) {
    return false;
  }

  // An IPv4-mapped or NAT64 address is an IPv4 address wearing a hat.
  const mapped = mappedIpv4(groups);
  if (mapped !== null) {
    return isPrivateIpv4(mapped);
  }

  const [first] = groups as [number, ...number[]];

  return (
    groups.every((group) => group === 0) || // ::
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) || // ::1
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
  );
}

function expandIpv6(address: string): number[] | null {
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0 || head === undefined) {
    return null;
  }

  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));

  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;

  if (tail === undefined && left.length !== 8) {
    return null;
  }
  if (missing < 0 || left.concat(right).some((group) => Number.isNaN(group))) {
    return null;
  }

  return [...left, ...Array.from({ length: Math.max(missing, 0) }, () => 0), ...right];
}

/** `::ffff:7f00:1` and `64:ff9b::7f00:1` both carry 127.0.0.1. */
function mappedIpv4(groups: readonly number[]): string | null {
  const isV4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isNat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);

  if (!isV4Mapped && !isNat64) {
    return null;
  }

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Whether a host literal, or a suffix that implies an internal name, must
 * be refused outright. Hostnames that merely *resolve* to a private
 * address are the job of {@link classifyHost}.
 */
export function isPrivateHost(host: string): boolean {
  // `new URL().hostname` keeps the brackets on an IPv6 literal.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  switch (isIP(bare)) {
    case 4:
      return isPrivateIpv4(bare);
    case 6:
      return isPrivateIpv6(bare);
    default:
      return (
        bare === 'localhost' ||
        bare.endsWith('.localhost') ||
        bare.endsWith('.local') ||
        bare.endsWith('.internal')
      );
  }
}

/**
 * Where a hostname actually points, as far as DNS will say right now.
 *
 * Three answers rather than two, because "could not resolve" is not
 * "unsafe". Validating the URL when the merchant saved it checks a
 * *string*; nothing stops `hooks.example.com` from pointing at `10.0.0.1`
 * the following week, or from answering differently each time it is
 * asked. Checking again at delivery is what turns the stored rule into an
 * enforced one.
 *
 * But a resolver blip must not be treated as an attack: collapsing it
 * into "private" would permanently kill deliveries that a retry would
 * have made fine. The caller decides, and the honest handling of
 * `unresolved` is to let the request proceed and fail the way any network
 * error does.
 *
 * This narrows the window rather than closing it: between this lookup and
 * the socket connecting, the name can change answer again. Closing it
 * fully means pinning the resolved address onto the connection with a
 * custom agent, which is the right next step if this ever faces untrusted
 * merchants at scale.
 */
export type HostClassification = 'public' | 'private' | 'unresolved';

export async function classifyHost(host: string): Promise<HostClassification> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (isIP(bare)) {
    return isPrivateHost(bare) ? 'private' : 'public';
  }
  // A name blocked by its own spelling needs no lookup.
  if (isPrivateHost(bare)) {
    return 'private';
  }

  try {
    const addresses = await lookup(bare, { all: true });

    if (addresses.length === 0) {
      return 'unresolved';
    }
    // Any private answer condemns the name: a round-robin that returns an
    // internal address some of the time is the attack, not an accident.
    return addresses.some((entry) => isPrivateHost(entry.address)) ? 'private' : 'public';
  } catch {
    return 'unresolved';
  }
}

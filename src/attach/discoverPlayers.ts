import * as dgram from 'dgram';

// Unity's Player Connection discovery protocol: every running Player/Editor instance with
// Script Debugging enabled re-broadcasts a UDP multicast announcement roughly once a second to
// this group, across a small set of well-known ports (the group/port set is not publicly
// documented as a stable API, but is consistently observed across Unity versions and mirrored by
// JetBrains' own Rider/ReSharper Unity support). This is a completely separate discovery
// mechanism from the local-process PowerShell scan in `unityProcess.ts` — there's no local pid to
// query for a remote Player, only what it chooses to announce over the network.
const MULTICAST_GROUP = '225.0.0.222';
const MULTICAST_PORTS = [54997, 34997, 57997, 58997];

// Long enough to reliably catch at least one announcement per instance (~1s cadence) with margin
// for jitter/dropped packets, short enough that invoking the attach command doesn't feel stuck.
const SCAN_DURATION_MS = 2000;

export interface PlayerCandidate {
	// The `[Id]` field's platform/host portion (e.g. "WindowsPlayer(DESKTOP-ABC)"), used as the
	// human-readable label — there's no separate "friendly name" field in the protocol.
	label: string;
	address: string;
	port: number;
	projectName?: string;
}

interface ParsedAnnouncement {
	fields: Map<string, string>;
	sourceAddress: string;
}

// Message body is space-separated "[Key] value" pairs, e.g.:
// "[IP] 10.0.1.152 [Port] 55000 [Flags] 3 [Guid] 123 [EditorId] 456 [Version] 1048832
//  [Id] iPhonePlayer(Example-iPhone):56000 [Debug] 1 [PackageName] iPhonePlayer"
// Values are taken as "everything up to the next [Key] token", so a value may itself contain
// spaces (this matters for [Id], which can be "WindowsPlayer(My PC):56000").
function parseAnnouncement(message: string, sourceAddress: string): ParsedAnnouncement {
	const fields = new Map<string, string>();
	const tokenPattern = /\[(\w+)\]\s*/g;
	const matches = [...message.matchAll(tokenPattern)];
	for (let i = 0; i < matches.length; i++) {
		const key = matches[i][1];
		const valueStart = matches[i].index! + matches[i][0].length;
		const valueEnd = i + 1 < matches.length ? matches[i + 1].index! : message.length;
		fields.set(key, message.slice(valueStart, valueEnd).trim());
	}
	return { fields, sourceAddress };
}

// The debug TCP port isn't a dedicated field — it's embedded as a ":port" suffix on [Id]
// (e.g. "WindowsPlayer(HOST):56000"). Falls back to the [Port] field (the player's own
// PlayerConnection port, not necessarily the mono debugger port) if [Id] has no such suffix —
// this is a heuristic, same spirit as the existing 56000+(pid%1000) formula-port guess in
// `unityProcess.ts`, since the protocol isn't a documented stable API.
function extractDebugPort(fields: Map<string, string>): number | undefined {
	const id = fields.get('Id');
	const idPortMatch = id?.match(/:(\d+)\s*$/);
	if (idPortMatch) {
		return parseInt(idPortMatch[1], 10);
	}
	const portField = fields.get('Port');
	return portField ? parseInt(portField, 10) : undefined;
}

// [Flags] bit 8 (value 8) documents whether [IP] should be trusted as reachable, vs. relying on
// the UDP packet's own source address (e.g. when the announced [IP] is a loopback/internal
// address that isn't meaningful to a remote listener). We don't fully bit-parse [Flags]; this
// approximates the documented intent by preferring [IP] except when it's clearly not usable.
function resolveAddress(fields: Map<string, string>, sourceAddress: string): string {
	const announced = fields.get('IP');
	if (announced && announced !== '127.0.0.1') {
		return announced;
	}
	return sourceAddress;
}

function toCandidate(parsed: ParsedAnnouncement): PlayerCandidate | undefined {
	if (parsed.fields.get('Debug') !== '1') {
		// Unity itself marks this instance as not accepting a debugger connection.
		return undefined;
	}
	const id = parsed.fields.get('Id');
	const port = extractDebugPort(parsed.fields);
	if (!id || !port) {
		return undefined;
	}
	return {
		label: id.replace(/:\d+\s*$/, ''),
		address: resolveAddress(parsed.fields, parsed.sourceAddress),
		port,
		projectName: parsed.fields.get('ProjectName'),
	};
}

function dedupeKey(fields: Map<string, string>): string {
	// An instance re-announces every ~1s during the scan window — Guid+EditorId together
	// identify one running instance (Guid alone can collide across simultaneously-launched
	// instances started from the same binary in some observed cases).
	return `${fields.get('Guid') ?? ''}#${fields.get('EditorId') ?? ''}`;
}

// Listens for `SCAN_DURATION_MS` across all known multicast ports, then resolves with whatever
// distinct instances announced themselves in that window. Never rejects on a per-socket bind/join
// failure (e.g. a port already in use by another listener on this machine) — that port is simply
// skipped, since the goal is best-effort discovery, not a guaranteed-complete result.
export function discoverPlayers(): Promise<PlayerCandidate[]> {
	return new Promise((resolve) => {
		const seen = new Map<string, PlayerCandidate>();
		const sockets: dgram.Socket[] = [];

		function finish(): void {
			for (const socket of sockets) {
				socket.close();
			}
			resolve([...seen.values()]);
		}

		for (const port of MULTICAST_PORTS) {
			const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			socket.on('error', () => {
				// Bind/join failure on this specific port — ignore and rely on the others.
			});
			socket.on('message', (message, rinfo) => {
				const parsed = parseAnnouncement(message.toString('utf8'), rinfo.address);
				const candidate = toCandidate(parsed);
				if (candidate) {
					seen.set(dedupeKey(parsed.fields), candidate);
				}
			});
			socket.bind(port, () => {
				try {
					socket.addMembership(MULTICAST_GROUP);
				} catch {
					// Group join failed (e.g. no suitable network interface) — this socket just
					// won't receive anything; other ports/sockets are unaffected.
				}
			});
			sockets.push(socket);
		}

		setTimeout(finish, SCAN_DURATION_MS);
	});
}

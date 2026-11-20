import * as net from 'net';

// Pre-attach health check for Unity's embedded mono debugger agent.
//
// Verified against Unity 2022.3 (mono 6.13, protocol 2.58):
//  - A client that completes the handshake and then sends VM_DISPOSE before closing leaves the
//    agent ready for the next connection immediately. That's what this probe does.
//  - A client that closes WITHOUT VM_DISPOSE (crash, kill, cancelled attach) leaves the agent
//    unable to complete any later handshake: the port still accepts TCP connections but never
//    answers, and a Domain Reload doesn't recover it — only restarting Unity does. Without this
//    probe, the debugger then just hangs until its own timeout.
//  - The agent services one client at a time, so a debugger that is already attached (Rider,
//    another Cursor window) produces the same "connects but never answers" symptom.

export type AgentProbeResult =
	| { status: 'ready'; handshakeMs: number }
	| { status: 'refused'; message: string }
	| { status: 'unresponsive' };

const HANDSHAKE = Buffer.from('DWP-Handshake', 'ascii');
const HANDSHAKE_TIMEOUT_MS = 1500;
const DISPOSE_REPLY_TIMEOUT_MS = 1500;

// JDWP-style packet header: length(4) id(4) flags(1), then command-set(1) command(1) for
// commands or error-code(2) for replies.
const HEADER_LENGTH = 11;
const REPLY_FLAG = 0x80;
const COMMAND_SET_VM = 1;
const VM_DISPOSE = 6;
const DISPOSE_PACKET_ID = 1;

function vmDisposePacket(): Buffer {
	const packet = Buffer.alloc(HEADER_LENGTH);
	packet.writeInt32BE(HEADER_LENGTH, 0);
	packet.writeInt32BE(DISPOSE_PACKET_ID, 4);
	packet.writeUInt8(0, 8);
	packet.writeUInt8(COMMAND_SET_VM, 9);
	packet.writeUInt8(VM_DISPOSE, 10);
	return packet;
}

// True once `buffer` contains the reply to our VM_DISPOSE. The agent may push event packets
// (e.g. VM_START) first, so skip over any complete packet that isn't it.
function containsDisposeReply(buffer: Buffer): boolean {
	let offset = 0;
	while (buffer.length - offset >= HEADER_LENGTH) {
		const length = buffer.readInt32BE(offset);
		if (length < HEADER_LENGTH || buffer.length - offset < length) {
			return false;
		}
		const id = buffer.readInt32BE(offset + 4);
		const flags = buffer.readUInt8(offset + 8);
		if (flags & REPLY_FLAG && id === DISPOSE_PACKET_ID) {
			return true;
		}
		offset += length;
	}
	return false;
}

export function probeDebuggerAgent(host: string, port: number): Promise<AgentProbeResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const socket = net.connect({ host, port });
		let phase: 'handshake' | 'dispose' | 'done' = 'handshake';
		let received = Buffer.alloc(0);
		let handshakeMs = 0;

		const finish = (result: AgentProbeResult) => {
			if (phase === 'done') {
				return;
			}
			phase = 'done';
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};

		// Handshake timeout => agent wedged or busy with another client. After a successful
		// handshake VM_DISPOSE has already been sent, so a missing reply is still "ready".
		let timer = setTimeout(() => finish({ status: 'unresponsive' }), HANDSHAKE_TIMEOUT_MS);

		socket.on('connect', () => socket.write(HANDSHAKE));
		socket.on('error', (err) => {
			if (phase === 'handshake') {
				finish({ status: 'refused', message: err.message });
			} else {
				finish({ status: 'ready', handshakeMs });
			}
		});
		socket.on('close', () => finish(phase === 'handshake' ? { status: 'unresponsive' } : { status: 'ready', handshakeMs }));
		socket.on('data', (chunk) => {
			received = Buffer.concat([received, chunk]);
			if (phase === 'handshake' && received.length >= HANDSHAKE.length) {
				if (!received.subarray(0, HANDSHAKE.length).equals(HANDSHAKE)) {
					finish({ status: 'refused', message: '端口上不是 mono 调试器（握手内容不匹配）' });
					return;
				}
				handshakeMs = Date.now() - startedAt;
				received = received.subarray(HANDSHAKE.length);
				phase = 'dispose';
				clearTimeout(timer);
				timer = setTimeout(() => finish({ status: 'ready', handshakeMs }), DISPOSE_REPLY_TIMEOUT_MS);
				socket.write(vmDisposePacket());
			}
			if (phase === 'dispose' && containsDisposeReply(received)) {
				finish({ status: 'ready', handshakeMs });
			}
		});
	});
}

import net from 'node:net';
import tls from 'node:tls';

const CONNECT_TIMEOUT_MS = 8000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_HEADER_BYTES = 16 * 1024;
// Time the server gets to acknowledge the end of the stream before the socket
// is destroyed. The retry backoff is longer, so no two sources overlap.
const CLOSE_GRACE_MS = 800;

/**
 * An error from the Icecast/Liquidsoap source connection.
 *
 * `fatal` means retrying cannot help: bad credentials, a mount that does not
 * exist, or a request the server refuses outright. Network problems stay
 * retriable so the supervisor can back off and try again.
 */
export class SourceError extends Error {
    constructor(message, { fatal = true, status = null, cause = null } = {}) {
        super(message);
        this.name = 'SourceError';
        this.fatal = fatal;
        this.status = status;
        this.cause = cause;
    }
}

/** Header values must never be able to inject extra headers or end the block. */
function headerValue(value) {
    return String(value ?? '').replace(/[\r\n]/g, ' ').trim();
}

function classifyStatus(status) {
    if (status === 401 || status === 403) {
        return new SourceError(
            'el servidor rechazó las credenciales (401/403): revisá AZURACAST_SOURCE_USER y AZURACAST_SOURCE_PASSWORD',
            { fatal: true, status },
        );
    }
    if (status === 404) {
        return new SourceError(
            'el servidor no reconoce ese mount (404): revisá AZURACAST_MOUNT',
            { fatal: true, status },
        );
    }
    if (status === 400 || status === 405) {
        return new SourceError(
            `el servidor rechazó la conexión de fuente (${status})`,
            { fatal: true, status },
        );
    }
    return new SourceError(`el servidor respondió ${status}`, { fatal: false, status });
}

function connectError(error, { host, port }) {
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
        return new SourceError(`no se pudo resolver el host "${host}"`, { fatal: true, cause: error });
    }
    if (error.code === 'ECONNREFUSED') {
        return new SourceError(`el servidor rechazó la conexión a ${host}:${port}`, { fatal: false, cause: error });
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
        return new SourceError(`no se pudo alcanzar ${host}:${port}`, { fatal: false, cause: error });
    }
    if (error.code === 'CERT_HAS_EXPIRED' || /certificate/i.test(error.message ?? '')) {
        return new SourceError(`el certificado TLS de ${host} no es válido: ${error.message}`, { fatal: true, cause: error });
    }
    return new SourceError(`error de red: ${error.message}`, { fatal: false, cause: error });
}

/**
 * Minimal Icecast source client (the same protocol butt speaks): one PUT
 * request, then the raw encoded stream. It exists because ffmpeg refuses to
 * stream to a mount of "/" ("No mountpoint (path) specified!"), which is
 * exactly what AzuraCast's Liquidsoap harbor expects.
 *
 * Usage: `await client.open()`, then `client.write(chunk)` with encoder output.
 */
export function createSourceClient({
    host,
    port,
    mount,
    user,
    password,
    contentType,
    useTls = false,
    name = '',
    genre = '',
    website = '',
    isPublic = false,
}) {
    let socket = null;
    let ready = false;
    let closed = false;
    let headerBuffer = '';
    let bytesSent = 0;
    let openedAt = null;
    let lastWriteAt = null;

    let pendingHandshake = null;
    const closeListeners = new Set();

    const emitClose = (reason) => {
        if (closed) return;
        closed = true;
        ready = false;
        for (const listener of closeListeners) listener(reason);
    };

    function requestHead() {
        const authorization = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
        const headers = [
            `PUT ${mount} HTTP/1.1`,
            `Host: ${host}:${port}`,
            `Authorization: Basic ${authorization}`,
            `Content-Type: ${contentType}`,
            'User-Agent: OBS-Radio-Agent/1.0',
        ];

        if (name) headers.push(`Ice-Name: ${headerValue(name)}`);
        if (genre) headers.push(`Ice-Genre: ${headerValue(genre)}`);
        if (website) headers.push(`Ice-Url: ${headerValue(website)}`);
        headers.push(`Ice-Public: ${isPublic ? 1 : 0}`);

        return `${headers.join('\r\n')}\r\n\r\n`;
    }

    function onData(chunk) {
        if (!pendingHandshake) return; // post-handshake server chatter is ignored

        headerBuffer += chunk.toString('latin1');
        const end = headerBuffer.indexOf('\r\n\r\n');
        if (end === -1) {
            if (headerBuffer.length > MAX_HEADER_BYTES) {
                const error = new SourceError('respuesta HTTP inválida del servidor', { fatal: false });
                settleHandshake(error);
            }
            return;
        }

        const head = headerBuffer.slice(0, end);
        const statusLine = head.split('\r\n')[0] ?? '';
        const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);

        if (!status) {
            settleHandshake(new SourceError(`respuesta inesperada del servidor: "${statusLine.slice(0, 60)}"`, { fatal: false }));
            return;
        }
        if (status >= 200 && status < 300) {
            settleHandshake(null);
            return;
        }
        settleHandshake(classifyStatus(status));
    }

    function settleHandshake(error) {
        const pending = pendingHandshake;
        if (!pending) return;
        pendingHandshake = null;
        clearTimeout(pending.timer);

        if (error) pending.reject(error);
        else pending.resolve();
    }

    function fail(error) {
        if (pendingHandshake) settleHandshake(error);
        try { socket?.destroy(); } catch { /* already gone */ }
        emitClose(error);
    }

    async function open() {
        if (socket) throw new Error('source client already opened');

        const connecting = useTls
            ? tls.connect({ host, port, servername: host })
            : net.connect({ host, port });

        socket = connecting;
        socket.setNoDelay(true);

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new SourceError(`tiempo de espera agotado conectando a ${host}:${port}`, { fatal: false }));
                try { socket.destroy(); } catch { /* already gone */ }
            }, CONNECT_TIMEOUT_MS);

            const onConnect = () => {
                clearTimeout(timer);
                socket.off('error', onEarlyError);
                resolve();
            };
            const onEarlyError = error => {
                clearTimeout(timer);
                reject(connectError(error, { host, port }));
            };

            socket.once(useTls ? 'secureConnect' : 'connect', onConnect);
            socket.once('error', onEarlyError);
        });

        socket.on('error', error => {
            if (ready) fail(connectError(error, { host, port }));
        });
        socket.on('close', () => emitClose(new SourceError('el servidor cerró la conexión', { fatal: false })));
        socket.on('data', onData);

        const handshake = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                settleHandshake(new SourceError('el servidor no respondió al pedido de fuente', { fatal: false }));
            }, HANDSHAKE_TIMEOUT_MS);
            pendingHandshake = { resolve, reject, timer };
        });

        socket.write(requestHead());

        try {
            await handshake;
        } catch (error) {
            // A socket left open without audio is a ghost source: the harbour
            // keeps it registered while Liquidsoap airs the AutoDJ.
            fail(error);
            throw error;
        }

        ready = true;
        openedAt = Date.now();
    }

    function write(chunk) {
        if (!ready || closed || !socket) return false;
        bytesSent += chunk.length;
        lastWriteAt = Date.now();
        return socket.write(chunk);
    }

    /**
     * Half-closes the stream and only then destroys the socket. Liquidsoap
     * releases the harbour when it sees the stream end; destroying the socket
     * right away can leave the station reporting a live source nobody sends,
     * and the next source is then dropped seconds after it authenticates.
     */
    function close() {
        closed = true;
        ready = false;

        const active = socket;
        socket = null;
        if (!active) return;

        const forceDestroy = () => {
            try { active.destroy(); } catch { /* already gone */ }
        };

        const graceTimer = setTimeout(forceDestroy, CLOSE_GRACE_MS);
        graceTimer.unref?.();
        active.once('close', () => clearTimeout(graceTimer));

        try {
            active.end();
        } catch {
            forceDestroy();
        }
    }

    function onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
    }

    function stats() {
        const elapsedMs = openedAt ? Date.now() - openedAt : 0;
        return {
            ready,
            bytesSent,
            elapsedMs,
            lastWriteAt,
            kbps: elapsedMs > 0 ? Math.round((bytesSent * 8) / elapsedMs) : 0,
        };
    }

    return { open, write, close, onClose, stats };
}

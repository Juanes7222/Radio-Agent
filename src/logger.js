import { appendFileSync, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.logDir, { recursive: true });

/**
 * Append-only log file that never blocks the event loop and keeps a single
 * rotated generation. A logger must never take the service down, so every IO
 * error is swallowed and late writes fall back to a synchronous append.
 */
class RotatingFile {
    constructor(file, maxBytes) {
        this.file = file;
        this.maxBytes = maxBytes;
        this.queue = [];
        this.stream = null;
        this.rotating = false;
        this.closed = false;
        this.open();
    }

    open() {
        this.size = this.currentSize();
        this.stream = createWriteStream(this.file, { flags: 'a' });
        this.stream.on('error', () => {});
        this.rotating = false;
    }

    currentSize() {
        try {
            return statSync(this.file).size;
        } catch {
            return 0;
        }
    }

    write(line) {
        if (this.closed || !this.stream) {
            this.writeSync(line);
            return;
        }
        this.queue.push(line);
        this.drain();
    }

    drain() {
        if (this.rotating || !this.stream) return;

        while (this.queue.length > 0) {
            const line = this.queue[0];
            const bytes = Buffer.byteLength(line);
            if (this.size > 0 && this.size + bytes > this.maxBytes) {
                this.rotate();
                return;
            }
            this.queue.shift();
            this.size += bytes;
            this.stream.write(line);
        }
    }

    rotate() {
        this.rotating = true;
        const stream = this.stream;
        this.stream = null;

        stream.end(() => {
            const rotated = `${this.file}.1`;
            try {
                rmSync(rotated, { force: true });
                renameSync(this.file, rotated);
            } catch {
                // Rotation is best effort; keep logging into the current file.
            }
            this.open();
            this.drain();
        });
    }

    writeSync(line) {
        try {
            appendFileSync(this.file, line);
        } catch {
            // Ignore: there is nowhere else to report this.
        }
    }

    close() {
        this.closed = true;
        const stream = this.stream;
        this.stream = null;
        if (!stream) return Promise.resolve();

        const pending = this.queue.splice(0).join('');
        if (pending) stream.write(pending);
        return new Promise(resolve => stream.end(resolve));
    }
}

const appFile = new RotatingFile(join(config.logDir, 'app.log'), config.logMaxBytes);
const errorFile = new RotatingFile(join(config.logDir, 'error.log'), config.logMaxBytes);

function format(level, message, error) {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    return error instanceof Error ? `${line}${error.stack ?? error.message}\n` : line;
}

function write(level, message, error = null) {
    const line = format(level, message, error);
    appFile.write(line);

    if (level === 'ERROR') {
        errorFile.write(line);
        process.stderr.write(line);
    } else {
        process.stdout.write(line);
    }
}

export const logger = {
    info: message => write('INFO', message),
    warn: message => write('WARN', message),
    error: (message, error = null) => write('ERROR', message, error),

    /**
     * Last-resort synchronous log for fatal handlers: the process is about to
     * exit, so buffered stream writes would be lost.
     */
    fatal(message, error = null) {
        const line = format('FATAL', message, error);
        process.stderr.write(line);
        try {
            appendFileSync(join(config.logDir, 'app.log'), line);
            appendFileSync(join(config.logDir, 'error.log'), line);
        } catch {
            // Nothing else to do while dying.
        }
    },

    close() {
        return Promise.all([appFile.close(), errorFile.close()]);
    },
};

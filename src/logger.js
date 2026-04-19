import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'daemon');
const ERROR_LOG_FILE = join(LOG_DIR, 'error.log');
const APP_LOG_FILE = join(LOG_DIR, 'app.log');

if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, message, error = null) {
    const timestamp = new Date().toISOString();
    let line = `${timestamp} [${level}] ${message}\n`;

    if (error && error instanceof Error) {
        line += `${error.stack}\n`;
    }

    process.stdout.write(line);
    appendFileSync(APP_LOG_FILE, line);

    if (level === 'ERROR') {
        process.stderr.write(line);
        appendFileSync(ERROR_LOG_FILE, line);
    }
}

export const logger = {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg, err = null) => write('ERROR', msg, err),
};
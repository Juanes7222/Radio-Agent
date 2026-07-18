import { execFile, exec } from 'child_process';
import { promisify }      from 'util';
import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';


const execAsync = promisify(exec);
const BUTT_EXE = process.env.BUTT_EXE_PATH;
const BUTT_CLIENT_EXE = path.join(path.dirname(BUTT_EXE), 'butt-client.exe');
const BUTT_CONFIG = process.env.BUTT_CONFIG_PATH;
const BACKEND_SECRET = process.env.BACKEND_SECRET
const BACKEND_URL = process.env.BACKEND_URL

const logDir = path.join(process.cwd(), 'daemon');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const outLog = fs.openSync(path.join(logDir, 'butt-out.log'), 'a');
const errLog = fs.openSync(path.join(logDir, 'butt-err.log'), 'a');

function spawnDetached(args, delayMs = 500) {
    return new Promise((resolve, reject) => {
        if (BUTT_CONFIG) {
            args = ['-c', BUTT_CONFIG, ...args];
        }
        const child = execFile(BUTT_EXE, args, {
            detached: true,
            stdio: [ 'ignore', outLog, errLog ],
            windowsHide: true,
        });
        child.on('error', reject);
        child.unref();
        setTimeout(resolve, delayMs);
    });
}

export function isRunning() {
    return execAsync('tasklist /FI "IMAGENAME eq butt.exe" /NH')
        .then(({ stdout }) => stdout.toLowerCase().includes('butt.exe'))
        .catch(() => false);
}

function sendCommand(args) {
    return new Promise((resolve, reject) => {
        execFile(BUTT_CLIENT_EXE, args, { windowsHide: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

export const launch      = () => spawnDetached([], 6000);
export const connect     = () => sendCommand(['-s']);
export const disconnect  = () => sendCommand(['-d']);
export const toggleMute  = () => sendCommand(['-M']); 

export async function updateMetadata(artist, title) {
    const songString = [artist, title].filter(Boolean).join(' - ');

    const results = await Promise.all([
        fetch(`${BACKEND_URL}/api/station/nowplaying/update`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': `${BACKEND_SECRET}`,
            },
            body: JSON.stringify({ artist, title }),
        }),
    ]);

    logger.info(`Server response: ${results[0].status} ${results[0].statusText}`);
}
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Opened once for the whole process lifetime: every butt.exe launch inherits
// these handles, so its output keeps appending to the same two files.
mkdirSync(config.logDir, { recursive: true });
const stdoutFd = openSync(join(config.logDir, 'butt-out.log'), 'a');
const stderrFd = openSync(join(config.logDir, 'butt-err.log'), 'a');

// The OBS panel polls every 2s; with a shorter TTL every poll would spawn
// tasklist again, so the cache must outlive one polling cycle.
const STATUS_TTL_MS = 5000;
const LAUNCH_POLL_MS = 250;

let cachedStatus = { value: false, at: 0 };
let pendingStatus = null;

async function queryRunning() {
    try {
        const { stdout } = await execFileAsync(
            'tasklist',
            ['/FI', `IMAGENAME eq ${config.buttProcessImage}`, '/NH'],
            { windowsHide: true, timeout: 5000 },
        );
        return stdout.toLowerCase().includes(config.buttProcessImage.toLowerCase());
    } catch (error) {
        logger.warn(`Could not query ${config.buttProcessImage}: ${error.message}`);
        return false;
    }
}

/**
 * Checking a process spawns tasklist (tens of milliseconds per call) and the
 * radio front-end polls the status endpoint, so the result is memoised briefly
 * and concurrent lookups share a single tasklist call.
 */
export function isRunning({ maxAgeMs = STATUS_TTL_MS } = {}) {
    if (cachedStatus.at !== 0 && Date.now() - cachedStatus.at < maxAgeMs) {
        return Promise.resolve(cachedStatus.value);
    }

    pendingStatus ??= queryRunning()
        .then(value => {
            cachedStatus = { value, at: Date.now() };
            return value;
        })
        .finally(() => {
            pendingStatus = null;
        });

    return pendingStatus;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function sendCommand(args) {
    return new Promise((resolve, reject) => {
        execFile(
            config.buttClientExe,
            args,
            { windowsHide: true, timeout: config.commandTimeoutMs },
            error => (error ? reject(error) : resolve()),
        );
    });
}

/**
 * Starts butt.exe and waits until the process actually exists instead of
 * sleeping a fixed amount of time, so the HTTP call returns as soon as the
 * broadcaster is up.
 */
export async function launch() {
    const args = config.buttConfig ? ['-c', config.buttConfig] : [];
    const child = spawn(config.buttExe, args, {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
    });

    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
    });
    child.unref();

    const deadline = Date.now() + config.launchTimeoutMs;
    while (Date.now() < deadline) {
        if (await isRunning({ maxAgeMs: 0 })) return;
        if (child.exitCode !== null) {
            throw new Error(`butt.exe exited while starting (code ${child.exitCode})`);
        }
        await delay(LAUNCH_POLL_MS);
    }

    if (child.exitCode !== null) {
        throw new Error(`butt.exe exited while starting (code ${child.exitCode})`);
    }
    // The process is alive but tasklist did not report it: keep the old
    // "launched" outcome instead of failing a working start.
    logger.warn(`butt.exe started but was not listed by tasklist within ${config.launchTimeoutMs}ms`);
    cachedStatus = { value: true, at: Date.now() };
}export const connect = () => sendCommand(['-s']);
export const disconnect = () => sendCommand(['-d']);


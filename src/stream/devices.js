import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 30000;
const DEVICE_LINE = /^\[dshow[^\]]*\]\s+"(.+?)"\s+\((audio|video)\)\s*$/;

let cache = { at: 0, value: null };

/** Parses the stderr listing ffmpeg prints for `-list_devices true`. */
export function parseDeviceList(output) {
    const devices = [];
    for (const line of String(output ?? '').split(/\r?\n/)) {
        const match = DEVICE_LINE.exec(line.trim());
        if (match) devices.push({ name: match[1], kind: match[2] });
    }
    return devices;
}

/**
 * Lists DirectShow audio capture devices. ffmpeg always exits non-zero for
 * this probe (there is no real input), so the listing lives on stderr.
 */
export async function listAudioDevices({ refresh = false } = {}) {
    if (!refresh && cache.value && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.value;
    }

    // The listing goes to stderr, and ffmpeg may still exit 0, so both the
    // resolved and the rejected result are inspected.
    let output = '';
    try {
        const result = await execFileAsync(
            config.ffmpegPath,
            ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
            { windowsHide: true, timeout: 8000 },
        );
        output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.error(`ffmpeg not found at "${config.ffmpegPath}"; set FFMPEG_PATH`);
            cache = { at: Date.now(), value: [] };
            return [];
        }
        output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    }

    const devices = parseDeviceList(output)
        .filter(device => device.kind === 'audio')
        .map(device => device.name);

    cache = { at: Date.now(), value: devices };
    return devices;
}

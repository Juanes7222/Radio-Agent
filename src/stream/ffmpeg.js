import { config } from '../config.js';
import { HttpError } from '../http-error.js';
import { logger } from '../logger.js';

export const CODECS = Object.freeze({
    mp3: { encoder: 'libmp3lame', format: 'mp3', contentType: 'audio/mpeg', label: 'MP3' },
    opus: { encoder: 'libopus', format: 'ogg', contentType: 'audio/ogg', label: 'Opus' },
});

export const SAMPLE_RATES = Object.freeze([44100, 48000]);

export const DEFAULTS = Object.freeze({
    device: '',
    codec: 'mp3',
    bitrateKbps: 128,
    sampleRate: 44100,
    channels: 2,
    gainDb: 0,
    mount: '',
});

const DEVICE_PREFIX = 'audio=';

/**
 * Validates and whitelists the persisted stream settings. Every value that
 * reaches ffmpeg passes through here, so nothing unvalidated can become an
 * argument.
 */
export function normalizeSettings(input) {
    const source = input ?? {};
    if (typeof source !== 'object' || Array.isArray(source)) {
        throw new HttpError(400, 'settings must be an object');
    }

    const codec = String(source.codec ?? DEFAULTS.codec);
    if (!CODECS[codec]) {
        throw new HttpError(400, `codec must be one of: ${Object.keys(CODECS).join(', ')}`);
    }

    const bitrateKbps = Number(source.bitrateKbps ?? DEFAULTS.bitrateKbps);
    if (!Number.isInteger(bitrateKbps) || bitrateKbps < 32 || bitrateKbps > 320) {
        throw new HttpError(400, 'bitrateKbps must be an integer between 32 and 320');
    }

    const sampleRate = Number(source.sampleRate ?? DEFAULTS.sampleRate);
    if (!SAMPLE_RATES.includes(sampleRate)) {
        throw new HttpError(400, `sampleRate must be one of: ${SAMPLE_RATES.join(', ')}`);
    }

    const channels = Number(source.channels ?? DEFAULTS.channels);
    if (channels !== 1 && channels !== 2) {
        throw new HttpError(400, 'channels must be 1 or 2');
    }

    const gainDb = Number(source.gainDb ?? DEFAULTS.gainDb);
    if (!Number.isFinite(gainDb) || gainDb < -20 || gainDb > 20) {
        throw new HttpError(400, 'gainDb must be between -20 and 20');
    }

    const device = String(source.device ?? DEFAULTS.device).trim();
    if (device.length > 200) {
        throw new HttpError(400, 'device name is too long');
    }

    const mount = String(source.mount ?? DEFAULTS.mount).trim();
    if (mount && !/^\/[A-Za-z0-9._\-/]{0,63}$/.test(mount)) {
        throw new HttpError(400, 'mount must start with "/" and use letters, digits, ".", "_", "-" or "/" only');
    }

    return {
        device,
        codec,
        bitrateKbps,
        sampleRate,
        channels,
        gainDb: Math.round(gainDb * 10) / 10,
        mount,
    };
}

/**
 * The mount actually used: the panel override when set, otherwise
 * AZURACAST_MOUNT. "/" is valid — AzuraCast's Liquidsoap harbor expects it.
 */
export function resolveMount(settings) {
    const mount = String(settings?.mount || config.azuracast.mount || '/').trim();
    return mount.startsWith('/') ? mount : `/${mount}`;
}

/**
 * ffmpeg argv for one live capture, encoded to stdout. The source connection to
 * the streaming server is made by the agent (see source-client.js) because
 * ffmpeg refuses to stream to a mount of "/".
 */
export function buildArgs(settings) {
    const codec = CODECS[settings.codec];

    const args = [
        '-hide_banner',
        '-nostdin',
        '-loglevel', 'warning',
        '-f', 'dshow',
        '-i', `${DEVICE_PREFIX}${settings.device}`,
        '-ac', String(settings.channels),
        '-ar', String(settings.sampleRate),
    ];

    if (settings.gainDb !== 0) {
        args.push('-af', `volume=${settings.gainDb}dB`);
    }

    args.push(
        '-c:a', codec.encoder,
        '-b:a', `${settings.bitrateKbps}k`,
    );

    if (settings.codec === 'opus') {
        args.push('-application', 'audio');
    }

    args.push('-f', codec.format, 'pipe:1');

    return args;
}

// Failures that will not fix themselves by retrying: a device that is gone, or
// arguments ffmpeg rejects outright.
const FATAL_PATTERNS = [
    [/could not find audio only device|could not find device|no such device|device not found/i, 'no se encontró el dispositivo de audio'],
    [/invalid argument/i, 'ffmpeg rechazó los parámetros de captura'],
    [/permission denied/i, 'el dispositivo de audio está en uso por otro programa'],
];

export function classifyFailure(stderr) {
    const text = String(stderr ?? '');
    for (const [pattern, reason] of FATAL_PATTERNS) {
        if (pattern.test(text)) return { fatal: true, reason };
    }
    return { fatal: false, reason: null };
}

export function lastMeaningfulLine(stderr) {
    const lines = String(stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.at(-1) ?? '';
}

export const describeCodec = codec => CODECS[codec]?.label ?? codec;

export function logSettings(settings) {
    logger.info(
        `ffmpeg settings: device="${settings.device}" codec=${settings.codec} `
        + `bitrate=${settings.bitrateKbps}k channels=${settings.channels} rate=${settings.sampleRate} gain=${settings.gainDb}dB `
        + `target=${config.azuracast.host}:${config.azuracast.port}${resolveMount(settings)}`,
    );
}

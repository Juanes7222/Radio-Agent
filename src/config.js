import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The .env file is resolved from the project root instead of the cwd: when the
// agent runs as a Windows service its cwd can be the node-windows daemon folder.
loadEnv({ path: join(ROOT_DIR, '.env'), quiet: true });

function required(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function optional(name, fallback = '') {
    return process.env[name]?.trim() || fallback;
}

function positiveInt(name, fallback) {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Environment variable ${name} must be a positive integer (got "${raw}")`);
    }
    return value;
}

// Relative paths are anchored to the project root: when the agent runs as a
// Windows service its cwd is not the project folder.
function pathOption(name, fallback) {
    const value = optional(name, fallback);
    return isAbsolute(value) ? value : join(ROOT_DIR, value);
}

function boolean(name, fallback = false) {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new Error(`Environment variable ${name} must be a boolean (got "${raw}")`);
}

function oneOf(name, allowed, fallback) {
    const raw = optional(name, fallback);
    if (!allowed.includes(raw)) {
        throw new Error(`Environment variable ${name} must be one of: ${allowed.join(', ')} (got "${raw}")`);
    }
    return raw;
}

const streamEngine = oneOf('STREAM_ENGINE', ['butt', 'ffmpeg'], 'butt');

// butt.exe is only needed by the legacy engine, so switching to ffmpeg lets a
// machine run without butt installed at all.
const buttExe = streamEngine === 'butt' ? required('BUTT_EXE_PATH') : optional('BUTT_EXE_PATH');

// Not frozen: src/agent-config.js overrides these values at runtime with what
// the panel saved, so every module must read them at call time.
export const config = {
    port: positiveInt('PORT', 3000),

    streamEngine,
    ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
    settingsFile: pathOption('STREAM_SETTINGS_FILE', 'stream-settings.json'),
    agentConfigFile: pathOption('AGENT_CONFIG_FILE', 'agent-config.json'),

    azuracast: {
        host: optional('AZURACAST_HOST'),
        port: positiveInt('AZURACAST_PORT', 8000),
        mount: optional('AZURACAST_MOUNT', '/stream'),
        sourceUser: optional('AZURACAST_SOURCE_USER', 'source'),
        sourcePassword: optional('AZURACAST_SOURCE_PASSWORD'),
        // TLS for the source connection (when the harbor is behind HTTPS).
        tls: boolean('AZURACAST_TLS', false),
        // Advisory headers sent to the streaming server with the source request.
        streamName: optional('AZURACAST_STREAM_NAME'),
        genre: optional('AZURACAST_GENRE'),
        website: optional('AZURACAST_WEBSITE'),
        isPublic: boolean('AZURACAST_IS_PUBLIC', false),
    },

    // Public origin that serves AzuraCast's now-playing API. Used only to
    // verify that the station is really airing the audio; the backend origin
    // proxies the same API, so it is the fallback.
    stationStatusUrl: optional('AZURACAST_PUBLIC_URL', optional('BACKEND_URL')).replace(/\/+$/, ''),

    buttExe,
    buttClientExe: join(dirname(buttExe || 'butt.exe'), 'butt-client.exe'),
    // tasklist filters by image name, which is whatever executable path is configured.
    buttProcessImage: basename(buttExe || 'butt.exe'),
    buttConfig: optional('BUTT_CONFIG_PATH'),
    launchTimeoutMs: positiveInt('BUTT_LAUNCH_TIMEOUT_MS', 8000),
    commandTimeoutMs: positiveInt('BUTT_COMMAND_TIMEOUT_MS', 10000),

    backendUrl: optional('BACKEND_URL').replace(/\/+$/, ''),
    backendSecret: optional('BACKEND_SECRET'),
    httpTimeoutMs: positiveInt('BUTT_HTTP_TIMEOUT_MS', 5000),

    logDir: pathOption('LOG_DIR', 'daemon'),
    logMaxBytes: positiveInt('LOG_MAX_BYTES', 5 * 1024 * 1024),
};

/**
 * Keeps the values derived from butt.exe in sync when the panel changes its path.
 * `buttClientExe` lives next to it and tasklist needs the bare image name.
 */
export function applyButtExe(exePath) {
    const exe = String(exePath ?? '').trim();
    config.buttExe = exe;
    config.buttClientExe = join(dirname(exe || 'butt.exe'), 'butt-client.exe');
    config.buttProcessImage = basename(exe || 'butt.exe');
}

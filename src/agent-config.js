import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, applyButtExe } from './config.js';
import { HttpError } from './http-error.js';
import { logger } from './logger.js';

/**
 * Settings the panel may change at runtime. The .env still provides the
 * defaults; this file overrides them and survives restarts, so the OBS panel
 * can reconfigure the agent without editing files by hand.
 *
 * Secrets are stored here in plain text, exactly like they are in .env: the file
 * stays inside the agent folder and is never sent to the browser.
 */
const MAX_PATH = 260;
const MAX_TEXT = 200;

let overrides = null;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value, name, { max = MAX_TEXT, allowEmpty = true } = {}) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);

    const clean = value.trim();
    if (!allowEmpty && !clean) throw new HttpError(400, `${name} cannot be empty`);
    if (clean.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
    if (/[\r\n]/.test(clean)) throw new HttpError(400, `${name} cannot contain line breaks`);
    return clean;
}

function portValue(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new HttpError(400, 'AZURACAST_PORT must be an integer between 1 and 65535');
    }
    return port;
}

function engineValue(value) {
    if (value !== 'ffmpeg' && value !== 'butt') {
        throw new HttpError(400, 'el motor debe ser "ffmpeg" o "butt"');
    }
    return value;
}

function mountValue(value) {
    const mount = text(value, 'mount');
    if (!mount) return '';
    if (!/^\/[A-Za-z0-9._\-/]{0,63}$/.test(mount)) {
        throw new HttpError(400, 'el mount debe empezar con "/" y usar letras, números, ".", "_", "-" o "/"');
    }
    return mount;
}

function urlValue(value, name) {
    const url = text(value, name);
    if (!url) return '';
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new HttpError(400, `${name} must be an http(s) URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new HttpError(400, `${name} must be an http(s) URL`);
    }
    return url.replace(/\/+$/, '');
}

function booleanValue(value) {
    if (typeof value !== 'boolean') throw new HttpError(400, 'el valor debe ser true o false');
    return value;
}

/** Fills in every editable field from the current effective configuration. */
function currentValues() {
    return {
        engine: config.streamEngine,
        ffmpegPath: config.ffmpegPath,
        buttExePath: config.buttExe,
        host: config.azuracast.host,
        port: config.azuracast.port,
        mount: config.azuracast.mount,
        sourceUser: config.azuracast.sourceUser,
        sourcePassword: config.azuracast.sourcePassword,
        tls: config.azuracast.tls,
        streamName: config.azuracast.streamName,
        genre: config.azuracast.genre,
        website: config.azuracast.website,
        isPublic: config.azuracast.isPublic,
        backendUrl: config.backendUrl,
        backendSecret: config.backendSecret,
    };
}

/** Validates a patch on top of the current values; omitted fields are kept. */
function normalize(patch) {
    if (!isPlainObject(patch)) throw new HttpError(400, 'la configuración debe ser un objeto');

    const next = { ...currentValues() };

    if ('engine' in patch) next.engine = engineValue(patch.engine);
    if ('ffmpegPath' in patch) next.ffmpegPath = text(patch.ffmpegPath, 'FFMPEG_PATH', { max: MAX_PATH, allowEmpty: false });
    if ('buttExePath' in patch) next.buttExePath = text(patch.buttExePath, 'BUTT_EXE_PATH', { max: MAX_PATH });
    if ('host' in patch) next.host = text(patch.host, 'AZURACAST_HOST', { max: 253 });
    if ('port' in patch) next.port = portValue(patch.port);
    if ('mount' in patch) next.mount = mountValue(patch.mount);
    if ('sourceUser' in patch) next.sourceUser = text(patch.sourceUser, 'AZURACAST_SOURCE_USER', { max: 100 });
    if ('sourcePassword' in patch) next.sourcePassword = text(patch.sourcePassword, 'AZURACAST_SOURCE_PASSWORD');
    if ('tls' in patch) next.tls = booleanValue(patch.tls);
    if ('streamName' in patch) next.streamName = text(patch.streamName, 'AZURACAST_STREAM_NAME');
    if ('genre' in patch) next.genre = text(patch.genre, 'AZURACAST_GENRE');
    if ('website' in patch) next.website = urlValue(patch.website, 'AZURACAST_WEBSITE');
    if ('isPublic' in patch) next.isPublic = booleanValue(patch.isPublic);
    if ('backendUrl' in patch) next.backendUrl = urlValue(patch.backendUrl, 'BACKEND_URL');
    if ('backendSecret' in patch) next.backendSecret = text(patch.backendSecret, 'BACKEND_SECRET');

    // Streams need somewhere to go: reject a half-configured target up front
    // instead of failing when the operator presses INICIAR.
    if (next.engine === 'ffmpeg' && (!next.host || !next.sourcePassword)) {
        throw new HttpError(400, 'con el motor ffmpeg hacen falta AZURACAST_HOST y AZURACAST_SOURCE_PASSWORD');
    }
    if (next.engine === 'butt' && !next.buttExePath) {
        throw new HttpError(400, 'con el motor butt hace falta la ruta de butt.exe');
    }

    return next;
}

function applyToConfig(values) {
    config.streamEngine = values.engine;
    config.ffmpegPath = values.ffmpegPath;
    applyButtExe(values.buttExePath);

    config.azuracast.host = values.host;
    config.azuracast.port = values.port;
    // An empty mount means "keep the environment default".
    if (values.mount) config.azuracast.mount = values.mount;
    config.azuracast.sourceUser = values.sourceUser || 'source';
    config.azuracast.sourcePassword = values.sourcePassword;
    config.azuracast.tls = values.tls;
    config.azuracast.streamName = values.streamName;
    config.azuracast.genre = values.genre;
    config.azuracast.website = values.website;
    config.azuracast.isPublic = values.isPublic;

    config.backendUrl = values.backendUrl;
    config.backendSecret = values.backendSecret;
}

function persist(values) {
    mkdirSync(dirname(config.agentConfigFile), { recursive: true });
    const temporary = `${config.agentConfigFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
    renameSync(temporary, config.agentConfigFile);
}

export function loadAgentConfig() {
    if (overrides) return overrides;

    try {
        const parsed = JSON.parse(readFileSync(config.agentConfigFile, 'utf8'));
        overrides = normalize(parsed);
        applyToConfig(overrides);
        logger.info(`Runtime configuration loaded from ${config.agentConfigFile}`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`Could not load ${config.agentConfigFile}: ${error.message}. Using .env values.`);
        }
        overrides = { ...currentValues() };
    }

    return overrides;
}

/** The shape the panel reads: secrets are reported as booleans only. */
export function agentConfigView() {
    const values = overrides ?? currentValues();

    return {
        engine: values.engine,
        ffmpegPath: values.ffmpegPath,
        buttExePath: values.buttExePath,
        source: {
            host: values.host,
            port: values.port,
            mount: values.mount || config.azuracast.mount || '/',
            user: values.sourceUser,
            tls: values.tls,
            passwordConfigured: Boolean(values.sourcePassword),
            streamName: values.streamName,
            genre: values.genre,
            website: values.website,
            isPublic: values.isPublic,
        },
        backend: {
            url: values.backendUrl,
            secretConfigured: Boolean(values.backendSecret),
        },
        file: config.agentConfigFile,
    };
}

/**
 * Persists and applies a change. Callers must ensure nothing is on air: the
 * server rejects this while a stream is active.
 */
export function updateAgentConfig(patch) {
    const next = normalize({ ...(overrides ?? currentValues()), ...patch });
    persist(next);
    overrides = next;
    applyToConfig(next);
    logger.info(`Runtime configuration saved to ${config.agentConfigFile} (engine: ${next.engine})`);
    return agentConfigView();
}

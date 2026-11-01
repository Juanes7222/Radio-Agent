import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { DEFAULTS, normalizeSettings } from './stream/ffmpeg.js';

let current = null;

function load() {
    try {
        const parsed = JSON.parse(readFileSync(config.settingsFile, 'utf8'));
        return normalizeSettings(parsed);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`Could not load ${config.settingsFile}: ${error.message}. Using defaults.`);
        }
        return { ...DEFAULTS };
    }
}

export function getSettings() {
    current ??= load();
    return current;
}

/**
 * Merges a partial update into the stored settings and writes them atomically:
 * a crash mid-write must never leave a half-written file behind.
 */
export function saveSettings(patch) {
    const next = normalizeSettings({ ...getSettings(), ...patch });

    mkdirSync(dirname(config.settingsFile), { recursive: true });
    const temporary = `${config.settingsFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, config.settingsFile);

    current = next;
    logger.info(`Stream settings saved to ${config.settingsFile}`);
    return next;
}

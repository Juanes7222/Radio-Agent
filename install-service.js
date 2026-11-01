import { join } from 'node:path';
import { Service } from 'node-windows';
import { config, ROOT_DIR } from './src/config.js';

// node-windows serialises these values into the service wrapper, so only the
// ones that are really set are passed: an undefined value would be written into
// the wrapper as the literal string "undefined".
const env = Object.entries({
    PORT: config.port,
    BUTT_EXE_PATH: config.buttExe,
    BUTT_CONFIG_PATH: config.buttConfig,
})
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: String(value) }));

const svc = new Service({
    name: 'RadioAgent',
    description: 'La Voz de la Verdad — radio agent for butt control',
    script: join(ROOT_DIR, 'src', 'index.js'),
    env,
});

svc.on('install', () => {
    svc.start();
    console.log('Service installed and started.');
});

svc.on('alreadyinstalled', () => {
    console.log('This service is already installed.');
});

svc.on('start', () => {
    console.log('Service started.');
});

svc.on('error', error => {
    console.error('Error:', error);
});

svc.install();

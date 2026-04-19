import { Service } from 'node-windows';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { configDotenv } from 'dotenv';
configDotenv();

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
    name:        'RadioAgent',
    description: 'La Voz de la Verdad — radio agent for butt control',
    script:      join(__dirname, 'src', 'index.js'),
    nodeOptions: [],
    env: [
        { name: 'PORT',             value: process.env.PORT },
        { name: 'BUTT_EXE_PATH',    value: process.env.BUTT_EXE_PATH },
        { name: 'BUTT_CONFIG_PATH', value: process.env.BUTT_CONFIG_PATH || join(process.env.APPDATA, 'buttrc') },
    ],
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

svc.on('error', (err) => {
    console.error('Error:', err);
});

svc.install();
import { Service } from 'node-windows';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
    name:   'RadioAgent',
    script: join(__dirname, 'src', 'index.js'),
});

svc.on('uninstall', () => {
    console.log('Service uninstalled complete.');
});
svc.on('error', (err) => {
    console.error('Uninstall error', err);
});
svc.uninstall();
// Opens the storage at a given moment so that two processes meet at the same
// instant: node test/fixtures/open-storage-at.mjs <file> <epoch ms>
import { openStorage } from '../../scripts/server-storage.mjs';
const [file, at] = process.argv.slice(2);
while (Date.now() < Number(at)) { /* spin until the shared start time */ }
try { openStorage(file, 'migrations').close(); console.log('ok'); }
catch (error) { console.log('error: ' + error.message); process.exitCode = 1; }

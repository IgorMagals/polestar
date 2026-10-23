// Runs target/wasm32-wasip1/release/sim-hash.wasm under node's WASI with the sim dir and the
// seeds preopened: node run-wasi.mjs <wasm> <sim dir> <seed dir> <seed file> [args...]
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
const [wasmFile, simDir, seedDir, seedFile, ...rest] = process.argv.slice(2);
const wasi = new WASI({ version: 'preview1', args: ['sim-hash', '/sim', `/seeds/${seedFile}`, ...rest], preopens: { '/sim': simDir, '/seeds': seedDir } });
const mod = await WebAssembly.compile(await readFile(wasmFile));
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
wasi.start(inst);

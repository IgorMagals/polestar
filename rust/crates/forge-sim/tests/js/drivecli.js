// polestar.js CLI with the scratch sim dir: node drivecli.js <polestar args...>
const { ROOT } = require('./drive-env');
require(ROOT + '/tools/polestar.js').main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.stack); process.exitCode = 1; });

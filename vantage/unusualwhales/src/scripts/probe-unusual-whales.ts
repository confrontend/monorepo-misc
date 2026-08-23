import { probeOptionTrades } from '../providers/unusualwhales.js';

const result = await probeOptionTrades({ ticker: process.argv[2] });
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;

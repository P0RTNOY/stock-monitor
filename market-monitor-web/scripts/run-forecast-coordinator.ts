import { runOperator } from '../operator/forecast-coordinator.ts';

process.exitCode = await runOperator(process.argv.slice(2));

import { runStatusOperator } from '../operator/forecast-scheduler.ts';

process.exitCode = await runStatusOperator(process.argv.slice(2));

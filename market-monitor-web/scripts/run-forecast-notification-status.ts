import { runStatusOperator } from '../operator/forecast-notifications.ts';

process.exitCode = await runStatusOperator(process.argv.slice(2));

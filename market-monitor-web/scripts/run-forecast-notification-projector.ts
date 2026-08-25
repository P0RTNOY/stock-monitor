import { runProjectionOperator } from '../operator/forecast-notifications.ts';

process.exitCode = await runProjectionOperator(process.argv.slice(2));

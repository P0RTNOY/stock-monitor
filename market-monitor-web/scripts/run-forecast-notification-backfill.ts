import { runBackfillOperator } from '../operator/forecast-notifications.ts';

process.exitCode = await runBackfillOperator(process.argv.slice(2));

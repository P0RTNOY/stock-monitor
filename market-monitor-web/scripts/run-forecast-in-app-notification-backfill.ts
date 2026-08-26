import { runInAppBackfillOperator } from '../operator/forecast-in-app-notifications.ts';
process.exitCode = await runInAppBackfillOperator(process.argv.slice(2));

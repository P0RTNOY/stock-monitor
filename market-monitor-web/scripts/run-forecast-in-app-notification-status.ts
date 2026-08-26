import { runInAppStatusOperator } from '../operator/forecast-in-app-notifications.ts';
process.exitCode = await runInAppStatusOperator(process.argv.slice(2));

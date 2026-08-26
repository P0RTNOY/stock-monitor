import { runInAppProjectOperator } from '../operator/forecast-in-app-notifications.ts';
process.exitCode = await runInAppProjectOperator(process.argv.slice(2));

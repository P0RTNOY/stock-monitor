import { runDispatchOperator } from '../operator/forecast-email.ts';

process.exitCode = await runDispatchOperator(process.argv.slice(2));

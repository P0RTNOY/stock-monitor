import { runEmailStatusOperator } from '../operator/forecast-email.ts';

process.exitCode = await runEmailStatusOperator(process.argv.slice(2));

import { runConsentOperator } from '../operator/forecast-email.ts';

process.exitCode = await runConsentOperator(process.argv.slice(2));

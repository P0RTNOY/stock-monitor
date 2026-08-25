import { runVerificationSendOperator } from '../operator/forecast-email.ts';

process.exitCode = await runVerificationSendOperator(process.argv.slice(2));

import { runRecipientOperator } from '../operator/forecast-email.ts';

process.exitCode = await runRecipientOperator(process.argv.slice(2));

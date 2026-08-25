import { runSimulationOperator } from '../operator/forecast-scheduler.ts';

process.exitCode = await runSimulationOperator(process.argv.slice(2));

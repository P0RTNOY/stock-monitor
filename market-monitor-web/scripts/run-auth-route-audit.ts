import { auditRoutes, parseAuditArguments, renderAudit } from '../operator/auth-audit.ts';

let options;
try {
  options = parseAuditArguments(process.argv.slice(2));
} catch {
  console.error('Invalid auth route audit invocation. Use --help.');
  process.exitCode = 2;
}

try {
  if (!options) {
    // Argument parsing already selected the stable usage-error exit code.
  } else if (options.help) console.log('Usage: npm run auth:route-audit -- [--json]');
  else {
    const report = auditRoutes();
    console.log(renderAudit(report, options.json));
    process.exitCode = report.releaseBlocking ? 1 : 0;
  }
} catch {
  console.error('Authorization route audit failed safely.');
  process.exitCode = 1;
}

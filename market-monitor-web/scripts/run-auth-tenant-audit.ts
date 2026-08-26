import {
  auditTenant,
  parseAuditArguments,
  renderAudit,
  type AuditArguments,
  withLocalD1,
} from '../operator/auth-audit.ts';

let options: AuditArguments | undefined;
try {
  options = parseAuditArguments(process.argv.slice(2));
} catch {
  console.error('Invalid tenant authorization audit invocation. Use --help.');
  process.exitCode = 2;
}

try {
  if (!options) {
    // Argument parsing already selected the stable usage-error exit code.
  } else if (options.help) console.log('Usage: npm run auth:tenant-audit -- [--json]');
  else {
    const report = await withLocalD1((d1) => auditTenant(d1));
    console.log(renderAudit(report, options.json));
    process.exitCode = report.releaseBlocking ? 1 : 0;
  }
} catch {
  console.error('Tenant authorization audit failed safely.');
  process.exitCode = 1;
}

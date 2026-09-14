// Start every run with an empty coverage cache, so a report only ever reflects
// the tests of this run (#396).
import { CoverageReport } from 'monocart-coverage-reports';
import { coverageOptions } from './options';

export default function globalSetup(): void {
  new CoverageReport(coverageOptions).cleanCache();
}

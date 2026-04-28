import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const REPORTERS = ['text', 'html', 'lcov'];

function writeCoverageReports(coverageMap, reportDir) {
  const context = libReport.createContext({
    dir: reportDir,
    defaultSummarizer: 'nested',
    coverageMap
  });

  for (const reporter of REPORTERS) {
    reports.create(reporter).execute(context);
  }
}

export {writeCoverageReports};

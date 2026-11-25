// Shared by CI and the packaged Windows runner. A declared NVDA block must
// identify the exact inventory and native run; legacy CI lanes use a minimum.
export function checkReport(report, minimum, { titles, binding } = {}) {
  const { stats, config, errors } = report;
  if (!Array.isArray(errors) || errors.length || config?.workers !== 1 ||
      !Array.isArray(config.projects) || !config.projects.length ||
      config.projects.some(p => p.retries !== 0) || stats?.flaky !== 0 || stats.unexpected !== 0 ||
      !Number.isInteger(stats.expected) || stats.expected < minimum)
    throw Error('Playwright did not confirm the expected native tests without retries');
  const expected = titles === undefined ? null : new Set(titles);
  if (expected && (!Array.isArray(titles) || !titles.length || titles.length !== expected.size ||
      titles.some(title => typeof title !== 'string' || !title) || config.projects.length !== 1))
    throw Error('Invalid block inventory or Playwright project count');
  if (binding && Object.entries(binding).some(([key, value]) => config.metadata?.hstMatrix?.[key] !== value))
    throw Error('Report metadata does not identify this NVDA block and attempt');
  const seen = new Set(), selected = new Set();
  let passed = 0, skipped = 0;
  function suite(s) {
    for (const spec of s.specs ?? []) {
      if (expected) {
        if (typeof spec.title !== 'string' || !spec.title || seen.has(spec.title) || spec.tests?.length !== 1)
          throw Error('Expected unique spec titles and a single project result for each');
        seen.add(spec.title);
      }
      for (const test of spec.tests) {
        const result = test.results?.[0];
        if (test.results?.length !== 1 || result?.retry !== 0 || !Array.isArray(result.errors) ||
            result.errors.length || result.status !== test.expectedStatus || !['passed','skipped'].includes(result.status) ||
            (expected && test.status !== (result.status === 'passed' ? 'expected' : 'skipped')))
          throw Error('Playwright reported a missing, failed, retried or unexpected test');
        if (result.status === 'passed') { passed++; selected.add(spec.title); } else skipped++;
      }
    }
    for (const child of s.suites ?? []) suite(child);
  }
  report.suites.forEach(suite);
  if (expected && (expected.size !== selected.size || [...expected].some(title => !selected.has(title))))
    throw Error('Selected spec titles differ from the expected block inventory');
  if (passed !== stats.expected || skipped !== stats.skipped) throw Error('Individual outcomes disagree with totals');
  return { passed, skipped };
}

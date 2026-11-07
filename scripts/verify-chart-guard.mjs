const { decideHomeVerification } = await import('../dist-electron/agent/verify-home.js');
const base = {
  request: 'show me graphs of renewable energy growth by year',
  currentRepairs: 0, maxRepairs: 2,
  wantsDeliverable: true, freshFiles: [], createdDeliverable: false, artifactValid: false,
  invalidArtifacts: [], missingFormats: [], contentInspections: [], mdFilesWithCharts: [],
  planItems: [], evidenceActions: [], homeReadOnlyStreak: 0, failedSkillNames: [],
};
const textOnly = decideHomeVerification({
  ...base,
  response: 'Renewable energy capacity has expanded dramatically over the last decade, with solar and wind leading the transition across every major market. Here is the breakdown of growth by year and technology.\n\n[[answer-in-chat]]',
});
const withCharts = decideHomeVerification({
  ...base,
  response: 'Renewable energy capacity has expanded dramatically over the last decade, and the momentum keeps building. Here is the growth picture by year and technology:\n```bar\ntitle "Renewable growth by year"\nx-axis "Year"\ny-axis "TWh"\nbar "2020" 2500\nbar "2021" 2900\nbar "2022" 3400\n```\n\n[[answer-in-chat]]',
});
console.log('text-only:', textOnly.outcome, '(expect failed-charts)');
console.log('with charts:', withCharts.outcome, '(expect chat-answer)');
if (textOnly.outcome !== 'failed-charts' || withCharts.outcome !== 'chat-answer') {
  process.exitCode = 1;
} else {
  console.log('chart guard verified');
}

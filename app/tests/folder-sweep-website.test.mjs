// folder-sweep-website.test.mjs — the website's sample of the fault sweeps (folder-sweep.test.mjs), in a
// process of its own, so that npm test runs the two apps' samples at once.
process.env.SHIORI_SWEEP_APP ||= 'website';
await import('./folder-sweep.test.mjs');

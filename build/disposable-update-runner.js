function requireDisposableUpdateRunner(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      env.RUNNER_OS !== "Windows" || env.STARLINK_DISPOSABLE_UPDATE_SMOKE !== "1") {
    throw new Error("This test requires a disposable GitHub-hosted Windows runner; ordinary local execution is refused.");
  }
}

module.exports = { requireDisposableUpdateRunner };

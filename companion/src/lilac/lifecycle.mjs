export function lilacRecoveryAction({ everConnected = false, lilacRunning = false } = {}) {
  if (!everConnected) return 'allow-initial-launch';
  return lilacRunning ? 'reattach-only' : 'exit';
}

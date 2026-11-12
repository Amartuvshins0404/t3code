let promptOpen = false;
const promptListeners = new Set<() => void>();

export function setCloudSignInPromptOpen(open: boolean) {
  promptOpen = open;
  for (const listener of promptListeners) listener();
}

export function openCloudSignInDialog() {
  setCloudSignInPromptOpen(true);
}

export function readCloudSignInPromptOpen() {
  return promptOpen;
}

export function subscribeCloudSignInPrompt(listener: () => void) {
  promptListeners.add(listener);
  return () => promptListeners.delete(listener);
}

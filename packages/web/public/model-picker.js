// Model-selection provider availability shared by the picker and its UI tests.
function isRememberableCustomEndpoint(raw) {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const value = raw.trim();
  try {
    const url = new URL(value);
    const authority = value.match(/^[a-z][a-z\d+.-]*:(?:\/\/)?([^/?#]*)/i)?.[1];
    return (url.protocol === "http:" || url.protocol === "https:") && !!authority &&
      !authority.includes("@") && !url.username && !url.password && !value.includes("?") && !value.includes("#");
  } catch {
    return false;
  }
}

export function modelPickerProviders(m) {
  return (m.providers ?? []).map((provider) => {
    if (!provider.custom || provider.customSetup !== undefined || m.provider !== provider.id || !m.ready || !isRememberableCustomEndpoint(m.baseUrl)) return provider;
    const apiKeyEnv = m.apiKeyEnv;
    return {
      ...provider,
      customSetup: {
        baseUrl: m.baseUrl,
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        authMode: apiKeyEnv || provider.hasSavedKey ? "credentialed" : "keyless",
        ready: true,
      },
      ...(apiKeyEnv ? { hasEnvKey: true } : {}),
    };
  }).filter((provider) =>
    provider.id === "github-copilot"
      ? !!m.copilot?.connected
      : provider.custom
        ? !!provider.customSetup?.ready && (
            provider.customSetup.authMode === "keyless" ||
            (provider.customSetup.authMode === "credentialed" && (!!provider.hasSavedKey || !!provider.hasEnvKey))
          )
        : !!provider.hasEnvKey || !!provider.hasSavedKey,
  );
}

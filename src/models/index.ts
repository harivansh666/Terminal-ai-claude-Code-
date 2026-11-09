import type { Provider } from "../types.js";
import { createProvider as createGeminiProvider } from "./gemini.js";

export type ProviderFactory = () => Provider;

/**
 * Registry of available AI model providers.
 * Stored as factory functions so providers are instantiated on demand
 * (avoiding premature API key checks during file import).
 */
export const provider: Record<string, ProviderFactory> = {
  gemini: createGeminiProvider,
};

/**
 * Retrieves and initializes a provider instance by name.
 *
 * @param name - Name of the provider (case-insensitive). Defaults to "gemini".
 * @returns The initialized Provider.
 * @throws Error if the requested provider is not supported.
 */
export function getProvider(name: string = "gemini"): Provider {
  const factory = provider[name.toLowerCase()];

  if (!factory) {
    const availableProviders = Object.keys(provider).join(", ");
    throw new Error(
      `Unknown provider: "${name}". Available providers: ${availableProviders}`,
    );
  }

  return factory();
}

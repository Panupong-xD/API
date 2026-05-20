import {
  formatClaudeMessage,
  formatGeminiMessage,
  formatOpenAIMessage
} from "../adapters.js";
import { modelRegistry } from "../modelRegistry.js";

export function formatForProvider(model, internalMessages) {
  const registryEntry = modelRegistry[model];
  let formatted;

  switch (registryEntry?.provider) {
    case "google":
      formatted = formatGeminiMessage(internalMessages);
      break;
    case "anthropic":
      formatted = formatClaudeMessage(internalMessages);
      break;
    default:
      formatted = formatOpenAIMessage(internalMessages);
  }

  return formatted.messages ?? formatted;
}

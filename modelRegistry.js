export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const modelRegistry = {
  "google/gemini-3-flash-preview": {
    provider: "google",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "google/gemini-3.1-pro-preview": {
    provider: "google",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "google/gemini-2.5-flash-image": {
    provider: "google",
    supportsVision: true,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "google/gemini-3-pro-image-preview": {
    provider: "google",
    supportsVision: true,
    supportsImageGeneration: true,
    supportsStreaming: true
  },

  "openai/gpt-5": {
    provider: "openai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "openai/gpt-5.2": {
    provider: "openai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "openai/gpt-5.4-mini": {
    provider: "openai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "openai/gpt-5.4-nano": {
    provider: "openai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "anthropic/claude-sonnet-4.6": {
    provider: "anthropic",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "anthropic/claude-opus-4.6": {
    provider: "anthropic",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "deepseek-v4-flash": {
    provider: "deepseek",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "x-ai/grok-4.1-fast": {
    provider: "xai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "qwen/qwen3-max-thinking": {
    provider: "qwen",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "meta-llama/llama-4-maverick": {
    provider: "meta",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  },

  "z-ai/glm-5": {
    provider: "zai",
    supportsVision: false,
    supportsImageGeneration: false,
    supportsStreaming: true
  }
};

export const allowedModelIds = Object.freeze(Object.keys(modelRegistry));

export function isAllowedModel(model) {
  return Boolean(model && modelRegistry[model]);
}

export default modelRegistry;

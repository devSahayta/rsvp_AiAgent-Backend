// utils/claudeClient.js
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Send a message to Claude with automatic retry on overload
 * @param {string} systemPrompt - System instructions
 * @param {array} messages - Conversation messages
 * @param {object} options - Model options (model, max_tokens, temperature)
 * @param {number} retries - Number of retry attempts (default: 3)
 * @returns {Promise<object>} - Claude's response
 */
export async function sendToClaude(
  systemPrompt,
  messages,
  options = {},
  retries = 3,
) {
  const maxRetries = retries;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Claude API attempt ${attempt}/${maxRetries}...`);

      const requestPayload = {
        model: options.model || process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: options.max_tokens || 500,
        system: systemPrompt,
        messages: messages,
        thinking: { type: "disabled" },
      };

      // Only include temperature if explicitly passed — some newer models
      // (e.g. claude-sonnet-5) reject this parameter entirely.
      if (options.temperature !== undefined) {
        requestPayload.temperature = options.temperature;
      }

      const response = await anthropic.messages.create(requestPayload);

      console.log(`✅ Claude API success on attempt ${attempt}`);
      const textBlock = response.content.find((block) => block.type === "text");

      return {
        text: textBlock?.text || "",
        usage: response.usage,
        model: response.model,
      };
    } catch (error) {
      lastError = error;

      // Check if it's a retryable error
      const isOverloaded =
        error.status === 529 || error.error?.error?.type === "overloaded_error";
      const isRateLimit = error.status === 429;
      const shouldRetry = error.headers?.get?.("x-should-retry") === "true";

      if (
        (isOverloaded || shouldRetry || isRateLimit) &&
        attempt < maxRetries
      ) {
        const delaySeconds = Math.min(Math.pow(2, attempt) * 1000, 10000); // Max 10s

        console.warn(
          `⚠️ Claude API ${error.status} (${error.error?.error?.type})`,
        );
        console.warn(
          `⏳ Retrying in ${delaySeconds / 1000}s... (attempt ${attempt + 1}/${maxRetries})`,
        );

        await new Promise((resolve) => setTimeout(resolve, delaySeconds));
        continue;
      }

      console.error(`❌ Claude API error (attempt ${attempt}/${maxRetries}):`, {
        status: error.status,
        type: error.error?.error?.type,
        message: error.message,
      });

      if (attempt === maxRetries) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Claude API failed after retries");
}

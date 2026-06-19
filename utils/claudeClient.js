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

      const response = await anthropic.messages.create({
        // claude-haiku-4-5 — fast, cost-efficient, perfect for conversational RSVP turns
        // Fallback via options.model if a specific caller needs a different model
        model: options.model || "claude-haiku-4-5-20251001",
        max_tokens: options.max_tokens || 500,
        temperature:
          options.temperature !== undefined ? options.temperature : 0.0,
        system: systemPrompt,
        messages: messages,
      });

      // Success!
      console.log(`✅ Claude API success on attempt ${attempt}`);

      return {
        text: response.content[0]?.text || "",
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

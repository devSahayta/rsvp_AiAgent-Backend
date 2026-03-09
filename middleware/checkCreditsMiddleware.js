// middleware/checkCreditsMiddleware.js
import { getUserById } from "../models/userModel.js";
import { CREDIT_PRICING, hasEnoughCredits } from "../config/creditPricing.js";

/**
 * Middleware to check if user has enough credits before allowing operation
 * 
 * Usage:
 * router.post("/test-chat", checkCreditsFor("test_chat"), testChatAgent);
 */
export const checkCreditsFor = (operationType) => {
  return async (req, res, next) => {
    try {
      const { user_id } = req.body;
      
      if (!user_id) {
        return res.status(400).json({ 
          error: "user_id is required",
          code: "MISSING_USER_ID" 
        });
      }
      
      // Get user credits
      const user = await getUserById(user_id);
      
      if (!user) {
        return res.status(404).json({ 
          error: "User not found",
          code: "USER_NOT_FOUND" 
        });
      }
      
      // Determine required credits based on operation type
      let requiredCredits = 0;
      let operationName = "";
      
      switch (operationType) {
        case "test_chat":
          requiredCredits = CREDIT_PRICING.TEST_CHAT_PER_MESSAGE;
          operationName = "Test Chat Message";
          break;
          
        case "test_voice":
          requiredCredits = CREDIT_PRICING.TEST_VOICE_PER_MINUTE; // Minimum 1 minute
          operationName = "Test Voice Call";
          break;
          
        case "production_chat":
          requiredCredits = CREDIT_PRICING.PRODUCTION_CHAT_PER_MESSAGE;
          operationName = "Chat Message";
          break;
          
        case "production_voice":
          requiredCredits = CREDIT_PRICING.PRODUCTION_VOICE_PER_MINUTE; // Minimum 1 minute
          operationName = "Voice Call";
          break;
          
        default:
          return res.status(400).json({ 
            error: "Invalid operation type",
            code: "INVALID_OPERATION" 
          });
      }
      
      // Check if user has enough credits
      if (!hasEnoughCredits(user.credits, requiredCredits)) {
        console.log(`❌ Insufficient credits for ${operationName}:`, {
          user_id,
          current: user.credits,
          required: requiredCredits,
          shortfall: requiredCredits - user.credits,
        });
        
        return res.status(402).json({ 
          error: "Insufficient credits",
          code: "INSUFFICIENT_CREDITS",
          current_balance: user.credits,
          required_credits: requiredCredits,
          shortfall: requiredCredits - user.credits,
          operation: operationName,
          message: `You need ${requiredCredits} credits for ${operationName}. Current balance: ${user.credits}`,
        });
      }
      
      console.log(`✅ Credits check passed for ${operationName}:`, {
        user_id,
        current: user.credits,
        required: requiredCredits,
      });
      
      // Attach user to request for use in controller
      req.user = user;
      
      next();
      
    } catch (error) {
      console.error("❌ Error in credit check middleware:", error);
      return res.status(500).json({ 
        error: "Failed to check credits",
        code: "CREDIT_CHECK_FAILED",
        details: error.message 
      });
    }
  };
};

/**
 * Middleware specifically for batch operations
 * Estimates total credits needed for entire batch
 */
export const checkCreditsForBatch = async (req, res, next) => {
  try {
    const { user_id, estimated_calls, estimated_minutes_per_call = 2 } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }
    
    const user = await getUserById(user_id);
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Estimate total credits needed
    const estimatedCredits = estimated_calls * estimated_minutes_per_call * CREDIT_PRICING.BATCH_CALL_PER_MINUTE;
    
    if (!hasEnoughCredits(user.credits, estimatedCredits)) {
      return res.status(402).json({ 
        error: "Insufficient credits for batch operation",
        current_balance: user.credits,
        estimated_required: estimatedCredits,
        shortfall: estimatedCredits - user.credits,
        message: `Estimated ${estimatedCredits} credits needed for ${estimated_calls} calls`,
      });
    }
    
    req.user = user;
    next();
    
  } catch (error) {
    console.error("❌ Error in batch credit check:", error);
    return res.status(500).json({ error: error.message });
  }
};
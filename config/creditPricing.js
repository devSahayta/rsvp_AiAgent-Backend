  // config/creditPricing.js

  /**
   * Centralized Credit Pricing Configuration
   * All credit costs are defined here for easy maintenance
   */
  export const CREDIT_PRICING = {
    // ========================================
    // PRODUCTION (Full Price)
    // ========================================
    
    /**
     * Production Voice Call (WhatsApp)
     * Charged per minute of call duration
     */
    PRODUCTION_VOICE_PER_MINUTE: 4,
    
    /**
     * Production Chat Message (WhatsApp)
     * Charged per AI response message
     */
    PRODUCTION_CHAT_PER_MESSAGE: 2,
    
    // ========================================
    // TEST MODE (50% Discount)
    // ========================================
    
    /**
     * Test Voice Call
     * Charged per minute of test call duration
     */
    TEST_VOICE_PER_MINUTE: 2,
    
    /**
     * Test Chat Message
     * Charged per AI test response
     */
    TEST_CHAT_PER_MESSAGE: 1,
    
    // ========================================
    // BATCH CALLS
    // ========================================
    
    /**
     * Batch Call (ElevenLabs)
     * Charged per minute across all calls in batch
     */
    BATCH_CALL_PER_MINUTE: 4,
  };

  /**
   * Utility: Round credits to 2 decimal places
   */
  export const formatCredits = (value) => {
    return Number(parseFloat(value || 0).toFixed(2));
  };

  /**
   * Utility: Calculate voice call credits
   */
  export const calculateVoiceCredits = (durationSeconds, isTestMode = false) => {
    const minutes = durationSeconds / 60;
    const pricePerMinute = isTestMode 
      ? CREDIT_PRICING.TEST_VOICE_PER_MINUTE 
      : CREDIT_PRICING.PRODUCTION_VOICE_PER_MINUTE;
    
    return formatCredits(minutes * pricePerMinute);
  };

  /**
   * Utility: Calculate chat message credits
   */
  export const calculateChatCredits = (messageCount = 1, isTestMode = false) => {
    const pricePerMessage = isTestMode
      ? CREDIT_PRICING.TEST_CHAT_PER_MESSAGE
      : CREDIT_PRICING.PRODUCTION_CHAT_PER_MESSAGE;
    
    return formatCredits(messageCount * pricePerMessage);
  };

  /**
   * Utility: Check if user has enough credits
   */
  export const hasEnoughCredits = (userCredits, requiredCredits) => {
    return userCredits >= requiredCredits;
  };
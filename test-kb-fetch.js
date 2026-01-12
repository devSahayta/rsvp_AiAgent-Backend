// test-kb-fetch.js
// Quick test script to verify KB system is working

import { getWeddingInfo } from "../rsvp_AiAgent-Backend/utils/weddingInfo.js";

async function testKBFetch() {
  console.log("🧪 Testing Knowledge Base Fetch\n");
  console.log("=".repeat(50));
  
  const testKbId = "69fd2a69-a8c1-4cfc-9dec-ffa1ecbd59c1";
  
  console.log(`\n📝 Testing with KB ID: ${testKbId}\n`);
  
  try {
    const result = await getWeddingInfo(testKbId);
    
    console.log("\n" + "=".repeat(50));
    console.log("📊 TEST RESULTS:");
    console.log("=".repeat(50));
    
    if (result) {
      console.log("✅ SUCCESS! KB data fetched");
      console.log(`\n📄 Content length: ${result.length} characters`);
      console.log(`\n📝 First 300 characters:\n`);
      console.log(result.substring(0, 300));
      console.log("\n...\n");
    } else {
      console.log("❌ FAILED! No data returned");
      console.log("\n🔍 Possible issues:");
      console.log("1. Supabase connection not configured");
      console.log("2. No entries in knowledge_entries table for this KB ID");
      console.log("3. KB ID doesn't exist in knowledge_bases table");
    }
    
  } catch (error) {
    console.log("❌ ERROR during test:", error.message);
    console.log("\n🔍 Stack trace:");
    console.log(error.stack);
  }
  
  console.log("\n" + "=".repeat(50));
}

// Run the test
testKBFetch().then(() => {
  console.log("\n✅ Test completed");
  process.exit(0);
}).catch(err => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
// test/quickDiagnostic.js
// Run this to test extraction with your actual uploaded document

import { extractAndStoreTravelInfo } from '../utils/supabaseTravelExtractor.js';
import dotenv from 'dotenv';

dotenv.config();

async function testWithActualDocument() {
  console.log('='.repeat(60));
  console.log('🧪 TESTING WITH YOUR ACTUAL DOCUMENT');
  console.log('='.repeat(60));

  // YOUR ACTUAL DOCUMENT URL
  const documentUrl = 'https://ktuozsngfmpgjwzleswa.supabase.co/storage/v1/object/sign/participant-docs/663c180a-593a-4aa4-831f-4ffcd679ae0b/b5e5dd0f-38a5-46d6-8121-454e8b006d5c/1764312443718_thivagar_image?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV80ZWY1MWZkNS05MjJkLTQxOTctYWQ1Yi05NWVkNTBhZjFlMDciLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJwYXJ0aWNpcGFudC1kb2NzLzY2M2MxODBhLTU5M2EtNGFhNC04MzFmLTRmZmNkNjc5YWUwYi9iNWU1ZGQwZi0zOGE1LTQ2ZDYtODEyMS00NTRlOGIwMDZkNWMvMTc2NDMxMjQ0MzcxOF90aGl2YWdhcl9pbWFnZSIsImlhdCI6MTc2NDMxMjg1MiwiZXhwIjoxNzY0MzEzMTUyfQ.wPhZ0NnqKfJMKeFsGQwIo8mXM-XfeKh-1WqIeqFSTS4';

  const testParams = {
    uploadId: 'test-upload-id',
    participantId: 'test-participant-id',
    eventId: 'test-event-id',
    documentUrl: documentUrl,
    documentType: 'Flight Ticket - Arrival',  // ⚠️ CRITICAL: Check if this matches what's in your database
    participantName: 'Thivagar'
  };

  console.log('\n📋 Test Parameters:');
  console.log(JSON.stringify(testParams, null, 2));
  console.log('\n' + '='.repeat(60));

  try {
    console.log('\n🚀 Starting extraction...\n');
    
    const result = await extractAndStoreTravelInfo(testParams);
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESULT:');
    console.log('='.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    
    if (result.success && result.stored) {
      console.log('\n✅ SUCCESS!');
      console.log('   Extraction worked');
      console.log('   Data stored in database');
      console.log('   Completeness:', result.completeness + '%');
    } else if (result.success && !result.stored) {
      console.log('\n⚠️ PARTIAL SUCCESS');
      console.log('   Extraction worked but storage failed');
      console.log('   Error:', result.error);
    } else {
      console.log('\n❌ FAILED');
      console.log('   Error:', result.error);
    }
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    console.error('Stack:', error.stack);
  }
}

testWithActualDocument();
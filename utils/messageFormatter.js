export function formatExtractResult(result) {
  if (!result.success) {
    return `❌ Extraction failed\nReason: ${result.error}`;
  }

  const d = result.extractedData;

  return `
🧾 *Travel Document Extracted Successfully!*

• Date: ${d.date || "N/A"}
• Time: ${d.time || "N/A"}
• From: ${d.from_location || "N/A"}
• To: ${d.to_location || "N/A"}
• Passenger: ${d.passenger_name || "N/A"}
• Transport No: ${d.transport_number || "N/A"}
• PNR: ${d.pnr || "N/A"}

✔️ Extraction complete!
`;
}

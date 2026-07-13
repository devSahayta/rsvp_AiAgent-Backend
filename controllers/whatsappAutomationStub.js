// controllers/whatsappAutomationStub.js
//
// DELETE this file once you give me your real whatsapp send-batch
// controller and I wire sendWhatsappTemplateToParticipants against it.
// Until then, mode='whatsapp' automations will log and no-op instead of
// crashing the scheduler run.

export async function sendWhatsappTemplateToParticipants(
  eventId,
  participantIds,
  templateId,
) {
  console.warn(
    `[whatsapp automation stub] would send template ${templateId} to ${participantIds.length} participant(s) for event ${eventId} — not implemented yet`,
  );
  return { sent: 0, failed: 0, skipped: participantIds.length };
}

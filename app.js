// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import waccountRoutes from "./routes/waccountRoutes.js";

import userRoutes from "./routes/userRoutes.js"; // if you have these
import eventRoutes from "./routes/eventRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import creditRoutes from "./routes/creditRoutes.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import { extractKindeUser } from "./middleware/extractKindeUser.js";
import { authenticateUser } from "./middleware/authMiddleware.js";
import chatRoutes from "./routes/chatRoutes.js";
import travelItineraryRoutes from "./routes/travelItineraryRoutes.js";
import whatsappTemplateRoutes from "./routes/whatsappTemplateRoutes.js";
import knowledgeBaseRoutes from "./routes/knowledgeBaseRoutes.js";
import adminChatRoutes from "./routes/adminChatRoutes.js";
import agentRoutes from "./routes/agentRoutes.js";
import transportRoutes from "./routes/transportRoutes.js";
import flightTrackingRoutes from "./routes/flightRoutes.js";
import agentSystemRoutes from "./routes/agentSystemRoutes.js";
import { startVoiceTestSyncCron } from "./crons/voiceTestSyncCron.js";
import { startProductionBatchSyncCron } from "./crons/productionBatchSyncCron.js";
import assistantRoutes from "./routes/assistantRoutes.js";
import voiceRoutes from "./routes/voiceRoutes.js";

import samvaadikRoutes from "./routes/samvaadikRoutes.js";
import retryAutomationRoutes from "./routes/retryAutomationRoutes.js";
import internalRoutes from "./routes/internalRoutes.js";

dotenv.config();
startVoiceTestSyncCron();
startProductionBatchSyncCron();

const app = express();
app.use(express.json());

// CORS: allow your frontend origin(s)
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://rsvp-ai-agent-frontend.vercel.app",
      "https://sutrak.ai",
    ],
    credentials: true,
  }),
);

// Always extract token (if present) so authenticateUser can rely on req.user
app.use(extractKindeUser);

// Mount user/event routes (if any)
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);

// Protect all /api/uploads routes (your choice) — this keeps current behavior
app.use("/api/uploads", authenticateUser, uploadRoutes);

app.use("/api/credits", creditRoutes);
app.use("/", whatsappRoutes);
app.use("/api", chatRoutes);
app.use("/api", travelItineraryRoutes);
// app.use("/api/waccount", waccountRoutes);

// //route for whatapp template
// app.use("/api/watemplates", whatsappTemplateRoutes);

//route for knowledge base
app.use("/api/knowledge-bases", knowledgeBaseRoutes);
app.use("/admin", adminChatRoutes);

//route for flight tracking
app.use("/api/flight-tracking", flightTrackingRoutes);

//for elevenlabs agent
app.use("/api/agents", agentRoutes);
//Transport routes
app.use("/api/transport", transportRoutes);

// Agent system routes
app.use("/api/agent-system", agentSystemRoutes);

// Voice routes
app.use("/api/voices", voiceRoutes);

// add after other routes:
app.use("/api/samvaadik", samvaadikRoutes);

app.use("/api/assistant", assistantRoutes);

app.get("/", (req, res) => res.send("API is running..."));

app.use(
  "/api/events/:eventId/retry-automations",
  authenticateUser,
  retryAutomationRoutes,
);

// scheduler-only, guarded by internalAuth (its own secret, no Kinde)
app.use("/internal", internalRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
import flightTrackingRoutes from "./routes/flightRoutes.js";

dotenv.config();

const app = express();
app.use(express.json());

// CORS: allow your frontend origin(s)
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://rsvp-ai-agent-frontend.vercel.app",
    ],
    credentials: true,
  })
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
app.use("/api/waccount", waccountRoutes);

//route for whatapp template
app.use("/api/watemplates", whatsappTemplateRoutes);

//route for knowledge base
app.use("/api/knowledge-bases", knowledgeBaseRoutes);
app.use("/admin", adminChatRoutes);

//route for flight tracking
app.use("/api/flight-tracking", flightTrackingRoutes);

//for elevenlabs agent
app.use("/api/agents", agentRoutes);

app.get("/", (req, res) => res.send("API is running..."));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

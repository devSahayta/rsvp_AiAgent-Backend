// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import userRoutes from "./routes/userRoutes.js"; // if you have these
import eventRoutes from "./routes/eventRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import creditRoutes from "./routes/creditRoutes.js";
import whatsappRoutes from "./routes/whatsappRoutes.js";
import { extractKindeUser } from "./middleware/extractKindeUser.js";
import { authenticateUser } from "./middleware/authMiddleware.js";

dotenv.config();

const app = express();
app.use(express.json());

// CORS: allow your frontend origin(s)
app.use(cors({
  origin: ["http://localhost:5173", "https://rsvp-ai-agent-frontend.vercel.app"],
  credentials: true,
}));

// Always extract token (if present) so authenticateUser can rely on req.user
app.use(extractKindeUser);

// Mount user/event routes (if any)
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);

// Protect all /api/uploads routes (your choice) — this keeps current behavior
app.use("/api/uploads", authenticateUser, uploadRoutes);

app.use("/api/credits", creditRoutes);
app.use("/", whatsappRoutes);

app.get("/", (req, res) => res.send("API is running..."));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// app.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import userRoutes from "./routes/userRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import creditRoutes from "./routes/creditRoutes.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors({ origin: ["http://localhost:5173","https://rsvp-ai-agent-frontend.vercel.app"] ,credentials: true }));

app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/credits", creditRoutes);

app.get("/", (_req, res) => res.send("API is running..."));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

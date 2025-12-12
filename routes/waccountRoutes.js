import express from "express";
import { createWAccount } from "../controllers/waccountController.js";

const router = express.Router();

// POST Route for saving WhatsApp account

router.post("/create-waccount", createWAccount);
export default router;

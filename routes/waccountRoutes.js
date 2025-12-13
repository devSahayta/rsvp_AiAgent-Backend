import express from "express";
import {
  createWAccount,
  getWAccount,
  updateWAccount,
} from "../controllers/waccountController.js";

const router = express.Router();

// CREATE (if not exist)
router.post("/create-waccount", createWAccount);

// FETCH
router.get("/get-waccount", getWAccount);

// UPDATE
router.post("/update-waccount", updateWAccount);

export default router;

import express from "express";
import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
} from "../controllers/knowledgeBaseController.js";

const router = express.Router();

// CREATE (if not exist)
router.post("/", createKnowledgeBase);

// FETCH
router.get("/", listKnowledgeBases);

// Get knowledge base content
router.get("/:id", getKnowledgeBase);

export default router;

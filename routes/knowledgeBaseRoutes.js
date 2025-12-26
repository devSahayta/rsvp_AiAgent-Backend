import express from "express";
import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
  deleteKnowledgeBase,
} from "../controllers/knowledgeBaseController.js";

const router = express.Router();

// CREATE (if not exist)
router.post("/", createKnowledgeBase);

// FETCH
router.get("/", listKnowledgeBases);

// Get knowledge base content
router.get("/:id", getKnowledgeBase);

router.delete("/:id", deleteKnowledgeBase);

export default router;

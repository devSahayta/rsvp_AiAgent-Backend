import express from "express";
import {
  createKnowledgeBase,
  listKnowledgeBases,
  getKnowledgeBase,
  deleteKnowledgeBase,
  getKBContentForAgent,
} from "../controllers/knowledgeBaseController.js";

const router = express.Router();

// CREATE (if not exist)
router.post("/", createKnowledgeBase);

// FETCH
router.get("/", listKnowledgeBases);

// ElevenLabs agent tool — fetch content by knowledge_base_id query param
// Must be declared before /:id to avoid Express treating "content" as an id
router.get("/content", getKBContentForAgent);

// Get knowledge base content
router.get("/:id", getKnowledgeBase);

router.delete("/:id", deleteKnowledgeBase);

export default router;

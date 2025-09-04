// routes/userRoutes.js
import express from "express";
import { addUser, fetchUsers, fetchUserById } from "../controllers/userController.js";

const router = express.Router();

// POST /api/users -> Create user
router.post("/", addUser);

// GET /api/users -> Get all users
router.get("/", fetchUsers);

// GET /api/users/:id -> Get user by ID
router.get("/:id", fetchUserById);

export default router;

// controllers/userController.js
import { createUser, getAllUsers, getUserById } from "../models/userModel.js";

// Create a new user
export const addUser = async (req, res) => {
  try {
    const { user_id, name, email } = req.body;

    if (!user_id || !name || !email) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const newUser = await createUser({
      user_id,
      name,
      email,
      created_at: new Date().toISOString(),
    });

    res.status(201).json({ message: "User created successfully", user: newUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Fetch all users
export const fetchUsers = async (req, res) => {
  try {
    const users = await getAllUsers();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Fetch a single user by ID
export const fetchUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id);

    if (!user) return res.status(404).json({ error: "User not found" });

    res.status(200).json(user);
  } catch (error) {
    console.error(error);  // log error
    res.status(500).json({ error: "Server error" });
  }
};


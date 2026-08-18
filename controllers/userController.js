// controllers/userController.js
import { createUser, getAllUsers, getUserById } from "../models/userModel.js";

// New accounts start with this many credits — a fixed server-side value,
// never taken from the request body. A client sending its own `credits`
// value in the POST body would otherwise be able to self-assign any
// balance it wants.
const DEFAULT_SIGNUP_CREDITS = 100;

// Create a new user
export const addUser = async (req, res) => {
  try {
    // Note: `credits` is intentionally NOT destructured from req.body —
    // see DEFAULT_SIGNUP_CREDITS above.
    const { user_id, name, email } = req.body;

    if (!user_id || !name || !email) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Idempotency check — this endpoint gets called more than once per
    // user in normal operation (every login, multiple tabs, React
    // StrictMode's double-invoked effects in dev). Without this check,
    // every repeat call after the first throws a duplicate-key error and
    // surfaces as a 500, which is exactly what was happening.
    const existing = await getUserById(user_id);
    if (existing) {
      return res
        .status(200)
        .json({ message: "User already exists", user: existing });
    }

    const newUser = await createUser({
      user_id,
      name,
      email,
      credits: DEFAULT_SIGNUP_CREDITS,
      created_at: new Date().toISOString(),
    });

    res
      .status(201)
      .json({ message: "User created successfully", user: newUser });
  } catch (error) {
    // Narrow race window: two near-simultaneous requests can both pass the
    // existence check above before either insert completes. If that
    // happens, the second insert still hits a duplicate-key error —
    // treat that as success (the user exists, which is what we wanted)
    // rather than surfacing it as a failure.
    const isDuplicateKeyError =
      error.code === "23505" || /duplicate key/i.test(error.message || "");

    if (isDuplicateKeyError) {
      try {
        const existing = await getUserById(req.body.user_id);
        if (existing) {
          return res
            .status(200)
            .json({ message: "User already exists", user: existing });
        }
      } catch (_) {
        // fall through to the generic 500 below
      }
    }

    console.error("[addUser] error:", error.message);
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
    console.error(error); // log error
    res.status(500).json({ error: "Server error" });
  }
};

export const fetchUserCredits = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getUserById(id);

    if (!user) return res.status(404).json({ error: "User not found" });

    res.status(200).json({ credits: user.credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

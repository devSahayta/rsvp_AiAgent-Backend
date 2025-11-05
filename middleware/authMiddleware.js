export const authenticateUser = async (req, res, next) => { 
    const user = req.user; 
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" }); 
    req.user = { user_id: user.id }
        next();
    }; // ✅ unify everywhere next(); };
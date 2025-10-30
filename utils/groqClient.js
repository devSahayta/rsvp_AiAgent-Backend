import { configDotenv } from "dotenv";
import Groq from "groq-sdk";
configDotenv()
console.log("🔑 GROQ API Key loaded:", !!process.env.GROQ_API_KEY);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  
});

export default groq;

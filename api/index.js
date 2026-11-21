// Vercel funksiyasi: barcha so‘rovlar server.js dagi handler’ga boradi
import { handler } from "../server.js";
export default handler;
export const config = { api: { bodyParser: false } };

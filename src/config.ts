//src/config.ts

import dotenv from "dotenv";
dotenv.config();

export const FARCASTER_BOT_MNEMONIC = process.env.FARCASTER_BOT_MNEMONIC!;
export const SIGNER_UUID = process.env.SIGNER_UUID!;
export const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY!;
export const PUBLISH_CAST_TIME = process.env.PUBLISH_CAST_TIME || "09:00";
export const TIME_ZONE = process.env.TIME_ZONE || "UTC";

export const FARCASTER_BOT_USERNAME = process.env.FARCASTER_BOT_USERNAME!;

export const FARCASTER_BOT_FID = process.env.FARCASTER_BOT_FID!;

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

export const HOSTING_DOMAIN = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}` 
  : "http://localhost:3000";


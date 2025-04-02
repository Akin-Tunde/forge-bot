import cron from "node-cron";
import neynarClient from "./neynarClient";
import { SIGNER_UUID, NEYNAR_API_KEY, FARCASTER_BOT_USERNAME, GEMINI_API_KEY, HOSTING_DOMAIN } from "./config";
import { isApiErrorResponse } from "@neynar/nodejs-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from 'path';

// Initialize Gemini with enhanced error handling
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Constants with type safety
const STATE_FILE = 'bot-state.json';
const LANDING_PAGES_DIR = path.join('dist', 'landing-pages');
const FARCASTER_BOT_FID = 1042522;
const RATE_LIMIT_WINDOW_MS = 1000;
const STATE_BACKUP_FILE = `${STATE_FILE}.bak`;

interface BotState {
  lastCheckedTime: string;
  processedCasts: string[];
  lastGeminiCall?: string;
  geminiRequestQueue: number[];
}

// Enhanced directory initialization
function initializeDirectories(): void {
  try {
    mkdirSync(LANDING_PAGES_DIR, { recursive: true });
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  } catch (error) {
    console.error("Directory initialization failed:", error);
    process.exit(1);
  }
}

initializeDirectories();

// Improved state management
function loadState(): BotState {
  const defaultState: BotState = {
    lastCheckedTime: new Date().toISOString(),
    processedCasts: [],
    geminiRequestQueue: []
  };

  if (!existsSync(STATE_FILE)) return defaultState;

  try {
    const rawData = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(rawData);
    
    return {
      ...defaultState,
      ...parsed,
      processedCasts: Array.isArray(parsed.processedCasts) ? parsed.processedCasts : defaultState.processedCasts,
      geminiRequestQueue: Array.isArray(parsed.geminiRequestQueue) ? 
        parsed.geminiRequestQueue : defaultState.geminiRequestQueue
    };
  } catch (error) {
    console.error("State loading failed, using defaults:", error);
    return defaultState;
  }
}

let botState: BotState = loadState();

// Robust state saving with backups
function saveState(): void {
  try {
    // Clean up state before saving
    const now = Date.now();
    botState = {
      ...botState,
      geminiRequestQueue: botState.geminiRequestQueue.filter(
        ts => now - ts < RATE_LIMIT_WINDOW_MS
      ),
      processedCasts: botState.processedCasts.length > 1000 ? 
        botState.processedCasts.slice(-1000) : botState.processedCasts
    };

    writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
    writeFileSync(STATE_BACKUP_FILE, JSON.stringify(botState, null, 2));
  } catch (error) {
    console.error("State saving failed:", error);
  }
}

// Enhanced template generator with better typing
interface TemplateParams {
  name?: string;
  description?: string;
  purpose?: string;
}

function getFallbackTemplate(params: TemplateParams): string {
  const safeParams = {
    name: params.name?.trim() || "Your Landing Page",
    description: params.description?.trim() || "A premium solution for your needs",
    purpose: params.purpose?.trim() || "Get Started"
  };

  return `<!DOCTYPE html>
<html lang="en">
<!-- Rest of your template remains the same -->
</html>`;
}

// Improved landing page generation
interface LandingPageParams {
  name: string;
  description: string;
  purpose: string;
}

async function generateLandingPage(params: LandingPageParams): Promise<string> {
  try {
    // Enhanced rate limiting
    const now = Date.now();
    botState.geminiRequestQueue = botState.geminiRequestQueue
      .filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

    if (botState.geminiRequestQueue.length > 0) {
      const delay = RATE_LIMIT_WINDOW_MS - (now - botState.geminiRequestQueue[0]);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro-latest",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      }
    });

    const prompt = `Generate a COMPLETE mobile-responsive HTML landing page...`; // Your prompt

    botState.geminiRequestQueue.push(Date.now());
    botState.lastGeminiCall = new Date().toISOString();
    saveState();

    const result = await model.generateContent(prompt);
    const html = (await result.response).text();

    if (!html.includes('<!DOCTYPE html>') || !html.includes('</html>')) {
      throw new Error("Invalid HTML structure");
    }

    return html;
  } catch (error) {
    console.error("Landing page generation failed:", error);
    return getFallbackTemplate(params);
  }
}

// Enhanced file saving with URL validation
function saveLandingPage(html: string, authorFid: number): string {
  const filename = `landing_${authorFid}_${Date.now()}.html`;
  const filePath = path.join(LANDING_PAGES_DIR, filename);

  if (!html.trim().startsWith('<!DOCTYPE html>')) {
    html = getFallbackTemplate({
      name: "Generated Page",
      description: "Custom landing page",
      purpose: "Sign Up"
    });
  }

  try {
    writeFileSync(filePath, html);
    const cleanDomain = HOSTING_DOMAIN.replace(/\/+$/, '');
    return `${cleanDomain}/landing-pages/${filename}`;
  } catch (error) {
    console.error("Failed to save landing page:", error);
    return `${HOSTING_DOMAIN}/error.html`;
  }
}

// Improved mention handling with better error recovery
async function checkMentionsAndReply(): Promise<void> {
  try {
    const { notifications } = await neynarClient.fetchAllNotifications({
      fid: FARCASTER_BOT_FID,
      limit: 10,
      type: ["mentions"]
    });

    if (!notifications?.length) return;

    for (const notification of notifications) {
      try {
        if (!notification?.cast?.hash || botState.processedCasts.includes(notification.cast.hash)) {
          continue;
        }

        const { cast } = notification;
        const mentionedUsername = `@${FARCASTER_BOT_USERNAME.toLowerCase()}`;
        const cleanText = cast.text.toLowerCase().replace(mentionedUsername, "").trim();

        if (cleanText.startsWith("landing")) {
          await handleLandingRequest(cast);
        } else if (/help|commands/.test(cleanText)) {
          await sendHelpResponse(cast);
        }

        botState.processedCasts.push(cast.hash);
        saveState();
      } catch (error) {
        console.error("Failed to process notification:", error);
      }
    }
  } catch (error) {
    console.error("Notification check failed:", error);
  }
}

// Extracted handler functions
async function handleLandingRequest(cast: any): Promise<void> {
  const parts = cast.text
    .toLowerCase()
    .replace(`@${FARCASTER_BOT_USERNAME.toLowerCase()} landing`, "")
    .trim()
    .split("|").map((s: string) => s.trim());

  if (parts.length < 3) {
    await neynarClient.publishCast({
      signerUuid: SIGNER_UUID,
      text: `@${cast.author.username} ❌ Format: @${FARCASTER_BOT_USERNAME} landing [name] | [description] | [purpose]`,
      parent: cast.hash
    });
    return;
  }

  const [name, description, purpose] = parts;
  const html = await generateLandingPage({ name, description, purpose });
  const fileUrl = saveLandingPage(html, cast.author.fid);

  await neynarClient.publishCast({
    signerUuid: SIGNER_UUID,
    text: `@${cast.author.username} 🎉 Landing page ready!\n\nView: ${fileUrl}`,
    parent: cast.hash
  });
}

async function sendHelpResponse(cast: any): Promise<void> {
  await neynarClient.publishCast({
    signerUuid: SIGNER_UUID,
    text: `@${cast.author.username} Bot commands:\n• "landing [name] | [desc] | [purpose]"\n• "help"`,
    parent: cast.hash
  });
}

// Startup with proper configuration validation
function validateConfig(): void {
  const requiredConfig = {
    SIGNER_UUID,
    NEYNAR_API_KEY,
    FARCASTER_BOT_USERNAME,
    GEMINI_API_KEY,
    HOSTING_DOMAIN
  };

  for (const [key, value] of Object.entries(requiredConfig)) {
    if (!value) {
      throw new Error(`Missing required configuration: ${key}`);
    }
  }
}

function startBot(): void {
  try {
    validateConfig();
    console.log(`🤖 ${FARCASTER_BOT_USERNAME} bot started`);
    
    cron.schedule("*/60 * * * * *", () => {
      checkMentionsAndReply().catch(console.error);
    });
    
    checkMentionsAndReply().catch(console.error);
  } catch (error) {
    console.error("Bot startup failed:", error);
    process.exit(1);
  }
}

startBot();
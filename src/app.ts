//src/app.ts

import cron from "node-cron";
import neynarClient from "./neynarClient";
import { SIGNER_UUID, NEYNAR_API_KEY, FARCASTER_BOT_USERNAME, GEMINI_API_KEY, HOSTING_DOMAIN } from "./config";
import { isApiErrorResponse } from "@neynar/nodejs-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from 'path';

// Constants
const STATE_FILE = 'bot-state.json';
const LANDING_PAGES_DIR = path.join('dist', 'landing-pages');
const FARCASTER_BOT_FID = 1042522;
const RATE_LIMIT_WINDOW_MS = 1000;
const MAX_REQUESTS_PER_WINDOW = 1;
const STATE_BACKUP_FILE = `${STATE_FILE}.bak`;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Logger
const logger = {
  info: (message: string) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message: string, error?: Error) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
    if (error) console.error(error.stack);
  }
};

// Interfaces
interface BotState {
  lastCheckedTime: string;
  processedCasts: string[];
  lastGeminiCall?: string;
  geminiRequestQueue: number[];
  maintenanceMode?: boolean;
}

interface TemplateParams {
  name?: string;
  description?: string;
  purpose?: string;
}

interface LandingPageParams {
  name: string;
  description: string;
  purpose: string;
}

// Initialize directories
function initializeDirectories(): void {
  try {
    mkdirSync(LANDING_PAGES_DIR, { recursive: true });
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    logger.info("Directories initialized successfully");
  } catch (error) {
    logger.error("Directory initialization failed:", error as Error);
    process.exit(1);
  }
}

initializeDirectories();

// State management
function loadState(): BotState {
  const defaultState: BotState = {
    lastCheckedTime: new Date().toISOString(),
    processedCasts: [],
    geminiRequestQueue: [],
    maintenanceMode: false
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
    logger.error("State loading failed, using defaults:", error as Error);
    return defaultState;
  }
}

let botState: BotState = loadState();

function saveState(): void {
  try {
    const now = Date.now();
    botState = {
      ...botState,
      geminiRequestQueue: botState.geminiRequestQueue.filter(
        ts => now - ts < RATE_LIMIT_WINDOW_MS
      ),
      processedCasts: botState.processedCasts.length > 1000 ? 
        botState.processedCasts.slice(-1000) : botState.processedCasts,
      lastCheckedTime: new Date().toISOString()
    };

    writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
    writeFileSync(STATE_BACKUP_FILE, JSON.stringify(botState, null, 2));
    logger.info("State saved successfully");
  } catch (error) {
    logger.error("State saving failed:", error as Error);
  }
}

// Template generation
function getFallbackTemplate(params: TemplateParams): string {
  const safeParams = {
    name: params.name?.trim() || "Your Landing Page",
    description: params.description?.trim() || "A premium solution for your needs",
    purpose: params.purpose?.trim() || "Get Started"
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeParams.name}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #333; }
    .cta { background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${safeParams.name}</h1>
    <p>${safeParams.description}</p>
    <a href="#" class="cta">${safeParams.purpose}</a>
  </div>
</body>
</html>`;
}

function validateLandingPage(html: string): boolean {
  const requiredTags = ['<!DOCTYPE html>', '<html', '<head', '<body', '<title'];
  return requiredTags.every(tag => html.includes(tag));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

async function generateLandingPage(params: LandingPageParams): Promise<string> {
  try {
    const now = Date.now();
    botState.geminiRequestQueue = botState.geminiRequestQueue
      .filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

    if (botState.geminiRequestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
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

    const prompt = `Generate a COMPLETE mobile-responsive HTML landing page with the following details:
- Title: ${params.name}
- Description: ${params.description}
- Primary CTA: ${params.purpose}

Include:
1. Modern, clean design
2. Mobile-responsive layout
3. Clear call-to-action
4. Appealing color scheme
5. Optimized for fast loading
6. Semantic HTML structure
7. Basic CSS in <style> tags
8. No external dependencies`;

    botState.geminiRequestQueue.push(Date.now());
    botState.lastGeminiCall = new Date().toISOString();
    saveState();

    const result = await model.generateContent(prompt);
    const html = (await result.response).text();

    if (!validateLandingPage(html)) {
      throw new Error("Generated HTML missing required elements");
    }

    return html;
  } catch (error) {
    logger.error("Landing page generation failed:", error as Error);
    return getFallbackTemplate(params);
  }
}

function saveLandingPage(html: string, authorFid: number): string {
  const safeFilename = `landing_${authorFid}_${Date.now()}.html`;
  const filename = sanitizeFilename(safeFilename);
  const filePath = path.join(LANDING_PAGES_DIR, filename);

  if (!validateLandingPage(html)) {
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
    logger.error("Failed to save landing page:", error as Error);
    return `${HOSTING_DOMAIN}/error.html`;
  }
}

// Bot operations
async function sendHelpResponse(cast: any): Promise<void> {
  const helpText = `@${cast.author.username} 🤖 Landing Page Bot Help:
  
• Create a landing page: 
  "@${FARCASTER_BOT_USERNAME} landing [Name] | [Description] | [Purpose]"
  
Example:
  "@${FARCASTER_BOT_USERNAME} landing My Startup | The best solution for X | Sign up now"

• Get help: "@${FARCASTER_BOT_USERNAME} help"`;

  await neynarClient.publishCast({
    signerUuid: SIGNER_UUID,
    text: helpText,
    parent: cast.hash
  });
}

async function handleLandingRequest(cast: any): Promise<void> {
  if (botState.maintenanceMode) {
    await neynarClient.publishCast({
      signerUuid: SIGNER_UUID,
      text: `@${cast.author.username} The bot is currently in maintenance mode. Please try again later.`,
      parent: cast.hash
    });
    return;
  }

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
        logger.error("Failed to process notification:", error as Error);
      }
    }
  } catch (error) {
    logger.error("Notification check failed:", error as Error);
  }
}

// Startup
async function checkApiConnections(): Promise<void> {
  try {
    await neynarClient.lookupUserByUsername({ username: FARCASTER_BOT_USERNAME });
    await genAI.getGenerativeModel({model: "gemini-pro"}).generateContent("test");
    logger.info("API connections verified");
  } catch (error) {
    throw new Error(`API connection test failed: ${(error as Error).message}`);
  }
}

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
      throw new Error(`Missing required configuration: ${key} (env: ${key})`);
    }
  }

  if (!HOSTING_DOMAIN.match(/^https?:\/\/.+/)) {
    throw new Error(`HOSTING_DOMAIN must be a valid URL (e.g., https://example.com)`);
  }
}

function startBot(): void {
  try {
    validateConfig();
    checkApiConnections();
    logger.info(`🤖 ${FARCASTER_BOT_USERNAME} bot started`);
    
    cron.schedule("*/60 * * * * *", () => {
      checkMentionsAndReply().catch(error => logger.error("Cron job failed:", error));
    });
    
    checkMentionsAndReply().catch(error => logger.error("Initial check failed:", error));
  } catch (error) {
    logger.error("Bot startup failed:", error as Error);
    process.exit(1);
  }
}

startBot();
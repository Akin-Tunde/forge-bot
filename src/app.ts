import cron from "node-cron";
import neynarClient from "./neynarClient";
import { SIGNER_UUID, NEYNAR_API_KEY, FARCASTER_BOT_USERNAME, GEMINI_API_KEY, HOSTING_DOMAIN } from "./config";
import { isApiErrorResponse } from "@neynar/nodejs-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from 'path';

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Constants
const STATE_FILE = 'bot-state.json';
const LANDING_PAGES_DIR = 'landing-pages';
const FARCASTER_BOT_FID = 1042522;

interface BotState {
  lastCheckedTime: string;
  processedCasts: string[];
  lastGeminiCall?: string;
  geminiRequestQueue: number[];
}

// Ensure directories exist
mkdirSync(LANDING_PAGES_DIR, { recursive: true });

let botState: BotState = {
  lastCheckedTime: new Date().toISOString(),
  processedCasts: [],
  geminiRequestQueue: []
};

if (existsSync(STATE_FILE)) {
  botState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

const saveState = () => {
  // Clean up old requests before saving
  const now = Date.now();
  botState.geminiRequestQueue = botState.geminiRequestQueue.filter(
    timestamp => now - timestamp < 5000
  );
  
  writeFileSync(STATE_FILE, JSON.stringify(botState));
  writeFileSync(STATE_FILE + '.bak', JSON.stringify(botState));
};

// Fallback Template Generator
const getFallbackTemplate = (params: { name: string, description: string, purpose: string }) => {
  const safeParams = {
    name: params.name || "Your Landing Page",
    description: params.description || "A premium solution for your needs",
    purpose: params.purpose || "Get Started"
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeParams.name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
  <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-100">
  <section class="bg-blue-600 text-white py-20">
    <div class="container mx-auto px-4 text-center">
      <h1 class="text-4xl md:text-5xl font-bold mb-4">${safeParams.name}</h1>
      <p class="text-xl">${safeParams.description.split('.')[0]}</p>
    </div>
  </section>

  <section class="py-16 container mx-auto px-4">
    <div class="grid md:grid-cols-3 gap-8">
      ${[1, 2, 3].map(i => `
      <div class="bg-white p-6 rounded-lg shadow-lg">
        <h3 class="text-xl font-semibold mb-3">Feature ${i}</h3>
        <p class="text-gray-600">${safeParams.description}</p>
      </div>
      `).join('')}
    </div>
  </section>

  <section class="bg-gray-800 text-white py-12">
    <div class="container mx-auto px-4 text-center">
      <a href="#" class="inline-block bg-blue-500 hover:bg-blue-400 text-white font-bold py-3 px-8 rounded-lg transition duration-200">
        ${safeParams.purpose}
      </a>
    </div>
  </section>
</body>
</html>`;
};

// HTML Validation
const validateHtml = (html: string) => {
  const REQUIRED_TAGS = [
    '<!DOCTYPE html>',
    'cdn.tailwindcss.com',
    '</html>'
  ];
  return REQUIRED_TAGS.every(tag => html.includes(tag));
};

// Landing Page Generation
const generateLandingPage = async (params: {
  name: string;
  description: string;
  purpose: string;
}): Promise<string> => {
  try {
    // Rate limiting - clear old requests
    const now = Date.now();
    botState.geminiRequestQueue = botState.geminiRequestQueue.filter(
      timestamp => now - timestamp < 1000
    );

    // If we have recent requests, wait
    if (botState.geminiRequestQueue.length >= 1) {
      const timeToWait = 1000 - (now - botState.geminiRequestQueue[0]);
      await new Promise(resolve => setTimeout(resolve, timeToWait));
    }

    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro-latest",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      }
    });
    
    const prompt = `Generate a COMPLETE mobile-responsive HTML landing page for "${params.name}" that:
    - MUST start with <!DOCTYPE html>
    - MUST include in <head>:
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
    
    - Body structure:
      1. Hero section with title and tagline
      2. Three feature sections
      3. CTA section
    
    - MUST use Tailwind CSS classes
    - MUST include container/padding classes
    - MUST end with </html>
    
    Return ONLY raw HTML with NO markdown or explanations.`;

    // Record the request time
    botState.geminiRequestQueue.push(Date.now());
    botState.lastGeminiCall = new Date().toISOString();
    saveState();

    const result = await model.generateContent(prompt);
    const html = (await result.response).text();

    if (!validateHtml(html)) {
      throw new Error("Generated HTML failed validation");
    }

    return html;
  } catch (error) {
    console.error("Using fallback template:", error);
    return getFallbackTemplate(params);
  }
};

// File Saving with Validation
const saveLandingPage = (html: string, authorFid: number): string => {
  const filename = `landing_${authorFid}_${Date.now()}.html`;
  const filePath = path.join(LANDING_PAGES_DIR, filename);
  
  if (!html.trim().startsWith('<!DOCTYPE html>')) {
    html = getFallbackTemplate({
      name: "Generated Page",
      description: "Custom landing page",
      purpose: "Sign Up"
    });
  }

  writeFileSync(filePath, html);
  return `${HOSTING_DOMAIN}/${filename}`;
};

// Mention Handling
// Mention Handling
const checkMentionsAndReply = async () => {
  try {
    const { notifications } = await neynarClient.fetchAllNotifications({
      fid: FARCASTER_BOT_FID,
      limit: 10,
      type: ["mentions"]
    });

    if (!notifications?.length) return;

    for (const notification of notifications) {
      try {
        // Skip if there's no cast or we've already processed it
        if (!notification?.cast || !notification.cast.hash || 
            botState.processedCasts.includes(notification.cast.hash)) {
          continue;
        }

        const { cast } = notification;
        const mentionedUsername = `@${FARCASTER_BOT_USERNAME.toLowerCase()}`;
        const cleanText = cast.text.toLowerCase().replace(mentionedUsername, "").trim();

        if (cleanText.startsWith("landing")) {
          const parts = cleanText.replace("landing", "").trim().split("|").map(s => s.trim());
          
          if (parts.length < 3) {
            await neynarClient.publishCast({
              signerUuid: SIGNER_UUID,
              text: `@${cast.author.username} ❌ Format: @${FARCASTER_BOT_USERNAME} landing [name] | [description] | [purpose]`,
              parent: cast.hash
            });
            continue;
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
        else if (/help|commands/.test(cleanText)) {
          await neynarClient.publishCast({
            signerUuid: SIGNER_UUID,
            text: `@${cast.author.username} Bot commands:\n• "landing [name] | [desc] | [purpose]"\n• "help"`,
            parent: cast.hash
          });
        }

        botState.processedCasts.push(cast.hash);
        saveState();
      } catch (err) {
        console.error("Error processing cast:", err);
        
        // Only try to reply if we have a valid cast reference
        if (notification?.cast?.hash && notification.cast.author?.username) {
          if (err instanceof Error && err.message.includes("Rate limited")) {
            await neynarClient.publishCast({
              signerUuid: SIGNER_UUID,
              text: `@${notification.cast.author.username} ⚠️ Please wait a moment and try again - I'm handling many requests!`,
              parent: notification.cast.hash
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Mention check error:", err);
  }
};

// Bot Startup
const startBot = () => {
  console.log(`🤖 ${FARCASTER_BOT_USERNAME} bot started`);
  cron.schedule("*/60 * * * * *", checkMentionsAndReply);
  checkMentionsAndReply(); // Immediate first check
};

// Config Validation
if (!SIGNER_UUID || !NEYNAR_API_KEY || !GEMINI_API_KEY || !HOSTING_DOMAIN) {
  throw new Error("Missing required configuration");
}

startBot();
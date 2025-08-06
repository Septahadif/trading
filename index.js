const AI_PROXY_ENDPOINT = "https://free.v36.cm/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// Trading Constants
const TRADABLE_ATR = 0.002;
const STRONG_VOLUME_RATIO = 1.5;
const STRONG_ADX = 20;
const ASIA_SESSION_ADX = 28;
const ASIA_SESSION_VOLUME = 2.0;
const SUPPORT_RESISTANCE_DISTANCE_ATR = 1.5;
const MACD_HISTOGRAM_MIN_CHANGE = 0.0001;
const VALID_PATTERNS = [
  'bullish engulfing', 'bearish engulfing',
  'hammer', 'shooting star',
  'double top', 'double bottom'
];

class TradingAI {
  constructor() {
    this.requestCache = new Map();
  }

  async callAI(data, freev36Key) {
    try {
      this.validateInputs(data);
      
      const derived = this.calculateDerivedValues(data, data.macd_hist_prev || 0);
      const userContent = this.buildAIPrompt(data, derived);
      
      const payload = {
        model: MODEL,
        messages: [{ role: "user", content: userContent }],
        temperature: 0.1,
        max_tokens: 150,
        response_format: { type: "json_object" }
      };

      const aiResponse = await this.fetchWithTimeout(
        AI_PROXY_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${freev36Key}`
          },
          body: JSON.stringify(payload)
        },
        10000
      );

      return aiResponse;
    } catch (error) {
      console.error('AI call failed:', error);
      return JSON.stringify(this.generateFallbackSignal(data.indicators || {}));
    }
  }

  calculateDerivedValues(data, macd_hist_prev) {
    const { ohlc, indicators, atr, support, resistance } = data;
    const price = ohlc.close;
    const hourUTC = new Date().getUTCHours();
    
    return {
      price,
      hourUTC,
      sessionType: this.getSessionType(hourUTC),
      macdHistCurrent: indicators.macd - indicators.macd_signal,
      isMacdRising: (indicators.macd - indicators.macd_signal) > (macd_hist_prev + MACD_HISTOGRAM_MIN_CHANGE),
      supportDistanceATR: (price - support) / atr,
      resistanceDistanceATR: (resistance - price) / atr,
      isNearSupport: (price - support) / atr <= SUPPORT_RESISTANCE_DISTANCE_ATR,
      isNearResistance: (resistance - price) / atr <= SUPPORT_RESISTANCE_DISTANCE_ATR,
      isValidPattern: VALID_PATTERNS.includes(data.pattern.toLowerCase()),
      trend: indicators.ema9 > indicators.ema21 ? "bullish" 
            : indicators.ema9 < indicators.ema21 ? "bearish" : "neutral",
      momentum: indicators.rsi > 70 ? "overbought" 
               : indicators.rsi < 30 ? "oversold" : "neutral",
      macdTrend: indicators.macd > indicators.macd_signal ? "bullish" : "bearish"
    };
  }

  buildAIPrompt(data, derived) {
    return `
You are an expert algorithmic trader. Respond ONLY in valid JSON:
{"signal": "buy|sell|hold", "explanation": "short reason with data"}

🔥 STRICT TRADING RULES (VIOLATION = HOLD):
1. Trend Strength:
   - ADX < ${STRONG_ADX} → HOLD (weak trend)
   - Asia Session? ADX must > ${ASIA_SESSION_ADX} & volume_ratio > ${ASIA_SESSION_VOLUME}

2. Momentum Filter:
   - RSI > 70 + Bullish → HOLD (overbought)
   - RSI < 30 + Bearish → HOLD (oversold)

3. Volume Confirmation:
   - volume_ratio < ${STRONG_VOLUME_RATIO} → HOLD (weak)
   - Asia Session: volume_ratio must > ${ASIA_SESSION_VOLUME}

4. MACD Requirements:
   - Buy: Histogram RISING (current > previous by ${MACD_HISTOGRAM_MIN_CHANGE})
   - Sell: Histogram FALLING (current < previous by ${MACD_HISTOGRAM_MIN_CHANGE})

5. Price Position:
   - Near Support (≤${SUPPORT_RESISTANCE_DISTANCE_ATR}x ATR) + Valid Bullish Pattern → Strong Buy
   - Near Resistance (≤${SUPPORT_RESISTANCE_DISTANCE_ATR}x ATR) + Valid Bearish Pattern → Strong Sell

6. Session Constraints:
   - ASIA (2-5 UTC): Extra strict rules
   - OVERLAP (8-12/14-17 UTC): Higher ATR allowed
   - REGULAR: Standard rules

🚨 FINAL DECISION:
- Jika SEMUA kondisi terpenuhi → Berikan sinyal
- Jika ADA 1 saja yang gagal → HOLD
- JANGAN menebak!

ANALYSIS:
- Symbol: ${this.sanitizeForPrompt(data.symbol)}, TF: ${data.tf}, Session: ${derived.sessionType}
- Price: ${derived.price.toFixed(5)} (Support: ${data.support.toFixed(5)}, Resistance: ${data.resistance.toFixed(5)})
- Trend: EMA9(${data.indicators.ema9.toFixed(5)}) ${derived.trend} vs EMA21(${data.indicators.ema21.toFixed(5)})
- Momentum: RSI(${data.indicators.rsi.toFixed(2)}) = ${derived.momentum}
- MACD: ${data.indicators.macd.toFixed(5)} vs Signal(${data.indicators.macd_signal.toFixed(5)}) → ${derived.macdTrend}
  Histogram: Current=${derived.macdHistCurrent.toFixed(5)}, Previous=${data.macd_hist_prev.toFixed(5)} → ${derived.isMacdRising ? 'RISING' : 'FALLING'}
- ADX: ${data.adx.toFixed(2)} (≥${STRONG_ADX} = strong)
- ATR: ${data.atr.toFixed(5)} (≥${TRADABLE_ATR} = tradable)
- Volume Ratio: ${data.volume_ratio.toFixed(2)} (≥${STRONG_VOLUME_RATIO} = strong)
- Pattern: ${data.pattern} ${derived.isValidPattern ? '(VALID)' : '(INVALID → HOLD)'}
- Position:
  - Support: ${derived.isNearSupport ? 'NEAR' : 'FAR'} (${derived.supportDistanceATR.toFixed(1)}x ATR)
  - Resistance: ${derived.isNearResistance ? 'NEAR' : 'FAR'} (${derived.resistanceDistanceATR.toFixed(1)}x ATR)

Respond in strict JSON only. No extra text. Example:
{"signal":"buy","explanation":"bullish trend (ADX 26), MACD rising, volume strong, price at support with bullish engulfing"}
    `;
  }

  async fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return (data?.choices?.[0]?.message?.content || "").trim();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  validateInputs(data) {
    const validateIndicator = (value, min, max, name) => {
      if (typeof value !== 'number' || isNaN(value) || value < min || value > max) {
        throw new Error(`Invalid ${name}: must be between ${min}-${max}`);
      }
    };

    validateIndicator(data.indicators.rsi, 0, 100, 'RSI');
    validateIndicator(data.adx, 0, 100, 'ADX');
    validateIndicator(data.atr, 0, Infinity, 'ATR');
    
    if (data.ohlc.high < data.ohlc.low) {
      throw new Error('Invalid OHLC: High must be >= Low');
    }
    
    if (data.ohlc.open <= 0 || data.ohlc.high <= 0 || data.ohlc.low <= 0 || data.ohlc.close <= 0) {
      throw new Error('Invalid OHLC: Prices must be positive');
    }
  }

  getSessionType(hourUTC) {
    if (hourUTC >= 2 && hourUTC < 5) return 'ASIA';
    if ((hourUTC >= 8 && hourUTC < 12) || (hourUTC >= 14 && hourUTC < 17)) return 'OVERLAP';
    return 'REGULAR';
  }

  sanitizeForPrompt(text) {
    return String(text).replace(/[{}<>\[\]'"`]/g, '');
  }

  generateFallbackSignal(indicators) {
    const { ema9, ema21, rsi } = indicators;
    if (ema9 > ema21 && rsi < 70) {
      return { signal: "buy", explanation: "Fallback: EMA bullish & RSI not overbought" };
    }
    if (ema9 < ema21 && rsi > 30) {
      return { signal: "sell", explanation: "Fallback: EMA bearish & RSI not oversold" };
    }
    return { signal: "hold", explanation: "Fallback: No clear trend" };
  }

  tryParseAI(aiRespText) {
    let cleaned = aiRespText.replace(/```json|```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      
      if (typeof parsed.signal !== 'string' || !["buy", "sell", "hold"].includes(parsed.signal.toLowerCase())) {
        throw new Error('Invalid signal value');
      }
      
      if (parsed.explanation && typeof parsed.explanation !== 'string') {
        throw new Error('Explanation must be string');
      }
      
      return {
        signal: parsed.signal.toLowerCase(),
        explanation: parsed.explanation ? String(parsed.explanation).substring(0, 500) : "No explanation"
      };
    } catch (e) {
      console.error("AI Response Parse Error:", e.message, cleaned);
      return this.generateFallbackSignal({});
    }
  }
}

// Telegram Service
class TelegramService {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async sendMessage(text) {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await this.fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: text,
            parse_mode: "HTML"
          })
        },
        5000 // 5 second timeout
      );
    } catch (error) {
      console.error("Telegram send failed:", error);
    }
  }

  async fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

// Main Worker Handler
class TradingWorker {
  constructor() {
    this.tradingAI = new TradingAI();
    this.telegramService = new TelegramService(
      globalThis.TELEGRAM_BOT_TOKEN,
      globalThis.TELEGRAM_CHAT_ID
    );
    this.lastRequestTime = 0;
  }

  async handle(request) {
    // Rate limiting (5 requests per minute)
    const now = Date.now();
    if (now - this.lastRequestTime < 12000) { // 12 second cooldown
      return this.createResponse(429, { error: "Too many requests" });
    }
    this.lastRequestTime = now;

    // Method check
    if (request.method !== "POST") {
      return this.createResponse(405, "Method Not Allowed");
    }

    // Authentication
    if (!this.authenticateRequest(request)) {
      return this.createResponse(401, { error: "Unauthorized" });
    }

    // Parse and validate request
    const { data, error } = await this.parseRequest(request);
    if (error) return error;

    // Process trading signal
    try {
      const aiText = await this.tradingAI.callAI(data, globalThis.FREEV36_API_KEY);
      const parsed = this.tradingAI.tryParseAI(aiText);

      // Send Telegram notification
      await this.sendTelegramNotification(data, parsed);

      return this.createResponse(200, parsed);
    } catch (error) {
      console.error("Processing error:", error);
      return this.createResponse(500, { 
        error: "Processing failed",
        message: error.message 
      });
    }
class TelegramService {
  constructor(botToken, chatId) {
    if (!botToken || !chatId) {
      throw new Error("Telegram credentials not provided");
    }
    this.botToken = botToken;
    this.chatId = chatId;
    this.maxRetries = 3;
    this.timeout = 8000;
  }

  async sendMessage(text) {
    const safeText = this.sanitizeText(text);
    const payload = {
      chat_id: this.chatId,
      text: safeText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          },
          this.timeout
        );

        const result = await response.json();
        if (!result.ok) {
          throw new Error(result.description || "Telegram API error");
        }
        return result;
      } catch (error) {
        if (attempt === this.maxRetries) {
          console.error(`Telegram send failed after ${attempt} attempts:`, error);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  sanitizeText(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .substring(0, 4000); // Telegram max length
  }

  async fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

class TradingWorker {
  constructor() {
    if (!globalThis.TELEGRAM_BOT_TOKEN || !globalThis.TELEGRAM_CHAT_ID) {
      console.warn("Telegram credentials not set - notifications disabled");
    }
    
    this.tradingAI = new TradingAI();
    this.telegramService = globalThis.TELEGRAM_BOT_TOKEN && globalThis.TELEGRAM_CHAT_ID
      ? new TelegramService(globalThis.TELEGRAM_BOT_TOKEN, globalThis.TELEGRAM_CHAT_ID)
      : null;
    this.rateLimits = new Map();
  }

  async handle(request) {
    // Rate limiting (5 requests/minute per IP)
    const clientIP = request.headers.get('cf-connecting-ip') || 'global';
    const now = Date.now();
    const window = 60000; // 1 minute
    
    if (!this.rateLimits.has(clientIP)) {
      this.rateLimits.set(clientIP, []);
    }
    
    const timestamps = this.rateLimits.get(clientIP);
    while (timestamps.length && timestamps[0] <= now - window) {
      timestamps.shift();
    }
    
    if (timestamps.length >= 5) {
      return this.createResponse(429, { error: "Too many requests" });
    }
    timestamps.push(now);

    // Method check
    if (request.method !== "POST") {
      return this.createResponse(405, { error: "Method Not Allowed" });
    }

    // Authentication
    if (!this.authenticateRequest(request)) {
      return this.createResponse(401, { error: "Unauthorized" });
    }

    try {
      const data = await this.parseRequest(request);
      const aiText = await this.tradingAI.callAI(data, globalThis.FREEV36_API_KEY);
      const parsed = this.tradingAI.tryParseAI(aiText);

      if (this.telegramService) {
        await this.sendTelegramNotification(data, parsed).catch(error => {
          console.error("Telegram notification failed:", error);
        });
      }

      return this.createResponse(200, parsed);
    } catch (error) {
      console.error("Processing error:", error);
      return this.createResponse(500, { 
        error: "Processing failed",
        details: error.message 
      });
    }
  }

  async sendTelegramNotification(data, parsedSignal) {
    if (!this.telegramService) return;

    const message = `
<b>🚀 ${parsedSignal.signal.toUpperCase()} SIGNAL</b>
<b>${this.escapeHtml(data.symbol)} | ${data.tf}</b>
📊 Price: <code>${data.ohlc.close.toFixed(5)}</code>
📈 Trend: ${this.escapeHtml(parsedSignal.explanation)}
⏰ ${new Date().toUTCString()}
    `.trim();

    await this.telegramService.sendMessage(message);
  }

  escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async parseRequest(request) {
    try {
      const data = await request.json();
      
      // Validate required fields
      const requiredFields = [
        'symbol', 'tf', 'ohlc', 'indicators',
        'adx', 'atr', 'volume_ratio', 'pattern',
        'session', 'support', 'resistance'
      ];
      
      const missingFields = requiredFields.filter(field => !data[field]);
      if (missingFields.length) {
        throw new Error(`Missing fields: ${missingFields.join(', ')}`);
      }
      
      return data;
    } catch (error) {
      throw new Error(`Invalid request: ${error.message}`);
    }
  }

  authenticateRequest(request) {
    const headerKey = request.headers.get("x-api-key");
    return headerKey && globalThis.PRE_SHARED_TOKEN && headerKey === globalThis.PRE_SHARED_TOKEN;
  }

  createResponse(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// Worker Initialization
const worker = new TradingWorker();

addEventListener('fetch', event => {
  event.respondWith(worker.handle(event.request));
});

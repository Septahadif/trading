const AI_PROXY_ENDPOINT = "https://free.v36.cm/v1/chat/completions";
const MODEL = "gpt-3.5-turbo-0125";

// Improved configuration - use environment variables
const TELEGRAM_BOT_TOKEN = globalThis.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = globalThis.TELEGRAM_CHAT_ID;

// Cache for analysis results
const analysisCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// Enhanced AI analysis function
async function callAI(symbol, tf, ohlc, prevCandles, indicators, volume, avgVolume, keyLevels, higherTF, marketContext, freev36Key) {
  // Validate inputs first
  validateTradingData(ohlc, prevCandles, indicators, volume, avgVolume);

  // Prepare enhanced prompt with clear rules
  const userContent = `Act as a professional trading analyst. Strictly follow these rules in JSON response:
  1. Trend Alignment: Never contradict higher timeframe trend (H1/D1).
  2. Overbought/Oversold: RSI >70 = caution long, <30 = caution short.
  3. Volume Confirmation: Spike >1.5x avg volume strengthens signals.
  4. MACD Cross: Bullish when MACD > Signal, bearish when MACD < Signal.
  5. Price Action: Rejections at S/R levels are high-probability signals.

  Current Analysis:
  - Symbol: ${symbol} (${tf})
  - Price: O=${ohlc.open} H=${ohlc.high} L=${ohlc.low} C=${ohlc.close}
  - EMA Cross: ${indicators.ema9 > indicators.ema21 ? "Bullish" : "Bearish"}
  - RSI: ${indicators.rsi} (${indicators.rsi > 70 ? "Overbought" : indicators.rsi < 30 ? "Oversold" : "Neutral"})
  - MACD: ${indicators.macd} (Signal: ${indicators.macd_signal}) → ${indicators.macd > indicators.macd_signal ? "Bullish" : "Bearish"}
  - Volume: ${volume} (Avg: ${avgVolume}) → ${volume > avgVolume * 1.5 ? "HIGH" : "Normal"}
  - Key Levels: Support=${keyLevels.s1}, Resistance=${keyLevels.r1}
  - Higher TF: H1=${higherTF.h1Trend}, D1=${higherTF.d1Trend}
  - Market: ${marketContext.session} session, ${marketContext.volatility} volatility

  Provide JSON response: { "signal": "buy/sell/hold", "confidence": "high/medium/low", "explanation": "..." }`;

  const payload = {
    model: MODEL,
    messages: [{ role: "user", content: userContent }],
    temperature: 0.1,
    max_tokens: 200,
    response_format: { type: "json_object" }
  };

  try {
    const resp = await fetch(AI_PROXY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${freev36Key}`
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error(`AI API Error: ${resp.status} ${await resp.text()}`);
    
    const data = await resp.json();
    const aiResponse = data?.choices?.[0]?.message?.content;
    
    if (!aiResponse) throw new Error("Empty AI response");
    
    return aiResponse;
  } catch (error) {
    console.error("AI call failed:", error);
    throw error;
  }
}

// Enhanced data validation
function validateTradingData(ohlc, prevCandles, indicators, volume, avgVolume) {
  // Validate OHLC structure
  if (!ohlc || typeof ohlc !== 'object') throw new Error("Invalid OHLC data");
  if (ohlc.high < ohlc.low) throw new Error("High price cannot be lower than low price");
  if (ohlc.open < 0 || ohlc.close < 0) throw new Error("Prices cannot be negative");

  // Validate indicators
  if (typeof indicators.rsi !== 'number' || indicators.rsi < 0 || indicators.rsi > 100) {
    throw new Error("Invalid RSI value");
  }
  if (typeof indicators.macd !== 'number' || typeof indicators.macd_signal !== 'number') {
    throw new Error("Invalid MACD values");
  }

  // Validate volume
  if (typeof volume !== 'number' || volume < 0) throw new Error("Invalid volume");
  if (typeof avgVolume !== 'number' || avgVolume <= 0) throw new Error("Invalid average volume");
}

// Enhanced signal filtering
function filterSignal(parsedSignal, indicators, volume, avgVolume, higherTF) {
  // Reject signals against strong higher timeframe trend
  if (parsedSignal.signal === "buy" && higherTF.d1Trend === "strong bearish") {
    return {
      ...parsedSignal,
      signal: "hold",
      confidence: "low",
      explanation: `${parsedSignal.explanation} (Rejected: Against D1 strong trend)`
    };
  }

  // Filter overbought/oversold signals without volume confirmation
  if (
    (parsedSignal.signal === "buy" && indicators.rsi > 70 && volume < avgVolume * 1.2) ||
    (parsedSignal.signal === "sell" && indicators.rsi < 30 && volume < avgVolume * 1.2)
  ) {
    return {
      ...parsedSignal,
      signal: "hold",
      confidence: "low",
      explanation: `${parsedSignal.explanation} (Rejected: Extreme RSI without volume confirmation)`
    };
  }

  return parsedSignal;
}

// Improved response parsing
function parseAIResponse(aiText) {
  try {
    const cleaned = aiText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    
    if (!parsed.signal || !["buy", "sell", "hold"].includes(parsed.signal.toLowerCase())) {
      throw new Error("Invalid signal value");
    }
    
    return {
      signal: parsed.signal.toLowerCase(),
      confidence: parsed.confidence || "medium",
      explanation: parsed.explanation || "No explanation provided"
    };
  } catch (e) {
    console.error("Failed to parse AI response:", e);
    return {
      signal: "hold",
      confidence: "low",
      explanation: "Error parsing AI response"
    };
  }
}

// Enhanced Telegram alert
async function sendTelegramAlert(symbol, timeframe, signal, confidence, explanation) {
  const emoji = {
    buy: "🟢",
    sell: "🔴",
    hold: "🟡"
  }[signal];

  const message = `
${emoji} *${signal.toUpperCase()} Signal* (${confidence} confidence)
📊 *${symbol}* | ${timeframe}
  
📌 *Reason*: ${explanation}
  
🔹 *Time*: ${new Date().toUTCString()}
  `;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
  
  if (!response.ok) {
    console.error("Telegram error:", await response.text());
  }
}

// Main handler with improved structure
async function handleRequest(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  // Auth check
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== globalThis.PRE_SHARED_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const requestData = await request.json();
    
    // Validate request structure
    if (!requestData.symbol || !requestData.timeframe) {
      throw new Error("Missing required fields");
    }

    // Create cache key
    const cacheKey = `${requestData.symbol}-${requestData.timeframe}-${JSON.stringify(requestData.ohlc)}`;
    if (analysisCache.has(cacheKey)) {
      const cached = analysisCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return new Response(JSON.stringify(cached.data), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Process analysis
    const aiResponse = await callAI(
      requestData.symbol,
      requestData.timeframe,
      requestData.ohlc,
      requestData.prevCandles,
      requestData.indicators,
      requestData.volume,
      requestData.avgVolume,
      requestData.keyLevels,
      requestData.higherTF,
      requestData.marketContext,
      globalThis.FREEV36_API_KEY
    );

    let parsedSignal = parseAIResponse(aiResponse);
    parsedSignal = filterSignal(
      parsedSignal,
      requestData.indicators,
      requestData.volume,
      requestData.avgVolume,
      requestData.higherTF
    );

    // Cache and send response
    analysisCache.set(cacheKey, {
      data: parsedSignal,
      timestamp: Date.now()
    });

    await sendTelegramAlert(
      requestData.symbol,
      requestData.timeframe,
      parsedSignal.signal,
      parsedSignal.confidence,
      parsedSignal.explanation
    );

    return new Response(JSON.stringify(parsedSignal), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Processing error:", error);
    return new Response(JSON.stringify({ 
      error: "Processing failed",
      details: error.message 
    }), { status: 500 });
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

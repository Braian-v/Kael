const axios = require("axios");
const { track } = require("./usage");

/**
 * Two-tier web search orchestration.
 * Tavily (monthly quota) is attempted first.
 * Serper (lifetime quota) is used as fallback on any Tavily failure.
 * Returns null if both providers are unavailable.
 */
async function searchWeb(query) {
  // Tier 1: Tavily
  try {
    const res = await axios.post("https://api.tavily.com/search", {
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
    });
    await track("tavily");
    return {
      source: "Tavily",
      data: res.data.results.map((r) => r.content).join("\n"),
    };
  } catch {
    // Tier 2: Serper
    try {
      const res = await axios.post(
        "https://google.serper.dev/search",
        { q: query },
        { headers: { "X-API-KEY": process.env.SERPER_API_KEY } }
      );
      await track("serper");
      return {
        source: "Serper",
        data: res.data.organic.map((r) => r.snippet).join("\n"),
      };
    } catch {
      return null;
    }
  }
}

module.exports = { searchWeb };
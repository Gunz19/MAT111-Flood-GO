// Flood Go public settings. Anyone can read this file in the browser,
// so never put API keys, tokens or other secrets here.
window.FLOODGO_CONFIG = {
  // Public URL of the AI backend, e.g. "https://floodgo-ai.<your-account>.workers.dev/api/ask".
  // Leave "" to answer from the built-in preset answers only. See README, "AI backend".
  aiEndpoint: "",

  // Minutes between automatic home-page weather refreshes (minimum 5).
  weatherRefreshMinutes: 15,

  // Basemap tiles. OpenStreetMap's standard tiles require the page to be served over
  // http(s) so the browser sends a Referer; opening the file directly (file://) gets blocked.
  // To switch provider, change these three values and follow that provider's terms.
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  tileMaxZoom: 19
};

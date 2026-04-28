export const environment = {
  production: false,
  phraseApiBaseUrl: '/api',
  phraseApiToken: '', // Loaded from settings page or localStorage
  openaiApiKey: '', // Set from settings or environment
  anthropicApiKey: '', // Set from settings or environment
  anthropicApiUrl: '/api/anthropic/v1/messages', // Routed through Angular dev proxy to bypass CORS
  googleCloudApiKey: '', // Set from settings or environment
};
